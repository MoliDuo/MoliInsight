import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct InsightConfig {
    /// The MoliInsight server, such as `https://insight.example.workers.dev`.
    public var endpoint: URL
    /// An ingest key (`mi_…`). It can be taken out of a binary, so it only writes, and can be revoked.
    public var key: String
    /// The app's version.
    public var release: String
    public var platform = "macos"
    public var deviceClass: String? = "desktop"
    public var os: String? = nil
    public var client: String? = nil
    public var locale: String? = Locale.current.identifier
    public var timeZone: String? = TimeZone.current.identifier
    /// When set, only these events go to the server. The rest stay in the local log.
    public var include: Set<String>? = nil
    /// These events never go to the server.
    public var exclude: Set<String> = []
    /// How often queued events are sent.
    public var flushInterval: TimeInterval = 30
    /// The oldest events are dropped beyond this.
    public var maxQueued = 5000

    public init(endpoint: URL, key: String, release: String) {
        self.endpoint = endpoint
        self.key = key
        self.release = release
    }
}

public struct InsightResponse {
    public var status: Int
    public var retryAfter: TimeInterval?
    public init(status: Int, retryAfter: TimeInterval? = nil) {
        self.status = status
        self.retryAfter = retryAfter
    }
}

public protocol InsightTransport {
    func send(_ request: URLRequest, completion: @escaping (Result<InsightResponse, Error>) -> Void)
}

public struct URLSessionTransport: InsightTransport {
    public var session: URLSession
    public init(session: URLSession = .shared) { self.session = session }

    public func send(_ request: URLRequest, completion: @escaping (Result<InsightResponse, Error>) -> Void) {
        session.dataTask(with: request) { _, response, error in
            if let error = error { return completion(.failure(error)) }
            guard let http = response as? HTTPURLResponse else {
                return completion(.failure(URLError(.badServerResponse)))
            }
            completion(.success(InsightResponse(
                status: http.statusCode,
                retryAfter: (http.value(forHTTPHeaderField: "Retry-After")).flatMap(TimeInterval.init)
            )))
        }.resume()
    }
}

struct QueuedEvent: Codable, Equatable {
    var id: String
    var name: String
    var occurredAt: String
    var mono: Double?
    var sessionId: String
    var props: [String: JSONValue]?
}

private struct Envelope: Encodable {
    struct Context: Encodable {
        var platform: String
        var release: String
        var deviceId: String
        var deviceClass: String?
        var os: String?
        var client: String?
        var locale: String?
        var timeZone: String?
    }
    var schemaVersion = 1
    var sentAt: String
    var context: Context
    var events: [QueuedEvent]
}

/// Sends a native program's usage events to MoliInsight.
///
/// It sits next to the program's own local log: the log keeps everything, this
/// sends the events worth keeping on a server. Events wait in a file until the
/// server has taken them, so being offline, or the server being down, loses
/// nothing. Nothing here throws or blocks the caller.
///
/// - Reading `deviceId`, `sessionId` and the queue is only done on the sink's own queue.
public final class InsightSink {
    public let config: InsightConfig
    private let transport: InsightTransport
    private let directory: URL
    private let now: () -> Date
    private let queue = DispatchQueue(label: "moli.insight.sink")

    private var enabled = true
    private var timer: DispatchSourceTimer?
    private var pending: [QueuedEvent] = []
    private var dirty = false
    private var inFlight = false
    private var blockedUntil = Date.distantPast
    private var failures = 0
    private var waiters: [() -> Void] = []
    private var deviceId = ""
    private var sessionId = ""

    /// Batch limits: the protocol's 100 events, and the server's 64 KB.
    static let maxBatch = 100
    static let maxBytes = 60_000
    static let sendAt = 50
    static let startDelay: TimeInterval = 5

    private static let formatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    /// - Parameter directory: where the device id and the queue are kept, such as a folder in Application Support.
    public init(
        config: InsightConfig,
        directory: URL,
        transport: InsightTransport = URLSessionTransport(),
        now: @escaping () -> Date = Date.init
    ) {
        self.config = config
        self.directory = directory
        self.transport = transport
        self.now = now
    }

    // MARK: - lifecycle

    /// Starts a session (one process run), restores what an earlier run left unsent and begins sending.
    public func start() {
        queue.async { [self] in
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            deviceId = loadDeviceId()
            sessionId = "ses_" + Self.randomHex(20)
            pending = loadQueue()
            enqueue(name: "$session_start", props: ["navType": .string("launch")], at: now(), mono: nil)

            let t = DispatchSource.makeTimerSource(queue: queue)
            t.schedule(deadline: .now() + config.flushInterval, repeating: config.flushInterval)
            t.setEventHandler { [self] in
                persistIfNeeded()
                sendNext(force: false)
            }
            t.resume()
            timer = t
            // A moment's grace, so the events of the first seconds go out together with the session start.
            queue.asyncAfter(deadline: .now() + Self.startDelay) { [self] in sendNext(force: false) }
        }
    }

    /// Turns sending on or off, for a "usage log" switch. Turning it off throws away what is queued.
    public func setEnabled(_ on: Bool) {
        queue.async { [self] in
            enabled = on
            if !on {
                pending = []
                dirty = true
                persistIfNeeded()
            }
        }
    }

    /// Saves the queue and tries to send it. `completion` runs once the attempt is over,
    /// which a program that is quitting can wait for, briefly.
    public func flush(completion: (() -> Void)? = nil) {
        queue.async { [self] in
            persistIfNeeded()
            if let completion = completion { waiters.append(completion) }
            sendNext(force: true)
            settle()
        }
    }

    // MARK: - recording

    /// Records one event. `fields` become the event's props; keys the server would refuse are rewritten.
    ///
    /// - Parameter mono: milliseconds on a monotonic clock, for exact intervals between events.
    public func record(_ name: String, fields: [String: Any] = [:], at date: Date? = nil, mono: Double? = nil) {
        let when = date ?? now()
        queue.async { [self] in
            guard enabled, allowed(name) else { return }
            var props: [String: JSONValue] = [:]
            for (key, value) in fields {
                if let converted = JSONValue(any: value) { props[InsightKey.sanitize(key)] = converted }
            }
            enqueue(name: name, props: props.isEmpty ? nil : props, at: when, mono: mono)
            if pending.count >= Self.sendAt { sendNext(force: false) }
        }
    }

    /// The same, for a line already shaped like the local log: `t`, `mono`, `e`, and the fields beside them.
    public func record(logLine: [String: Any]) {
        var fields = logLine
        let name = fields.removeValue(forKey: "e") as? String
        let mono = (fields.removeValue(forKey: "mono") as? NSNumber)?.doubleValue
        var date: Date?
        if let t = fields.removeValue(forKey: "t") as? String { date = Self.parse(t) }
        guard let name = name else { return }
        record(name, fields: fields, at: date, mono: mono)
    }

    // MARK: - internals (on the queue)

    private func allowed(_ name: String) -> Bool {
        if config.exclude.contains(name) { return false }
        if name.hasPrefix("$") { return true }
        if let include = config.include { return include.contains(name) }
        return true
    }

    private func enqueue(name: String, props: [String: JSONValue]?, at date: Date, mono: Double?) {
        pending.append(QueuedEvent(
            id: UUID().uuidString.lowercased(),
            name: name,
            occurredAt: Self.formatter.string(from: date),
            mono: mono,
            sessionId: sessionId,
            props: props
        ))
        if pending.count > config.maxQueued { pending.removeFirst(pending.count - config.maxQueued) }
        dirty = true
    }

    private func sendNext(force: Bool) {
        guard enabled, !inFlight, !pending.isEmpty else { return settle() }
        if !force && now() < blockedUntil { return settle() }

        let batch = fitBatch()
        guard let body = encode(batch) else {
            // Cannot happen for what was queued; do not get stuck on it.
            pending.removeFirst(batch.count)
            return sendNext(force: force)
        }
        var request = URLRequest(url: config.endpoint.appendingPathComponent("v1/ingest"))
        request.httpMethod = "POST"
        request.httpBody = body
        request.timeoutInterval = 15
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(config.key)", forHTTPHeaderField: "Authorization")

        inFlight = true
        transport.send(request) { [self] result in
            queue.async { [self] in
                inFlight = false
                finish(batch, result, force: force)
            }
        }
    }

    private func finish(_ batch: [QueuedEvent], _ result: Result<InsightResponse, Error>, force: Bool) {
        let ids = Set(batch.map(\.id))
        func remove() {
            pending.removeAll { ids.contains($0.id) }
            dirty = true
            // The file must not keep what the server already has: a crash would send it again.
            persistIfNeeded()
        }
        switch result {
        case .failure:
            backOff()
        case .success(let response):
            switch response.status {
            case 200..<300:
                remove()
                failures = 0
                blockedUntil = .distantPast
                return sendNext(force: force)
            case 401, 403:
                // The key was revoked or is wrong. Waiting is all that helps; a new build may carry a new key.
                blockedUntil = now().addingTimeInterval(3600)
            case 429:
                blockedUntil = now().addingTimeInterval(response.retryAfter ?? 60)
            case 500...:
                backOff()
            default:
                // The server refuses this batch for good. Sending it again cannot work.
                remove()
                return sendNext(force: force)
            }
        }
        persistIfNeeded()
        settle()
    }

    private func backOff() {
        failures += 1
        blockedUntil = now().addingTimeInterval(min(15 * pow(2, Double(failures - 1)), 600))
    }

    private func settle() {
        guard !inFlight else { return }
        let done = waiters
        waiters = []
        done.forEach { $0() }
    }

    private func fitBatch() -> [QueuedEvent] {
        var n = min(Self.maxBatch, pending.count)
        while n > 1, (encode(Array(pending.prefix(n)))?.count ?? 0) > Self.maxBytes { n = (n + 1) / 2 }
        return Array(pending.prefix(n))
    }

    private func encode(_ events: [QueuedEvent]) -> Data? {
        let context = Envelope.Context(
            platform: config.platform, release: config.release, deviceId: deviceId,
            deviceClass: config.deviceClass, os: config.os, client: config.client,
            locale: config.locale, timeZone: config.timeZone
        )
        return try? JSONEncoder().encode(Envelope(sentAt: Self.formatter.string(from: now()), context: context, events: events))
    }

    // MARK: - files

    private var queueFile: URL { directory.appendingPathComponent("queue.json") }
    private var deviceFile: URL { directory.appendingPathComponent("device-id") }

    private func loadDeviceId() -> String {
        if let saved = try? String(contentsOf: deviceFile, encoding: .utf8) {
            let id = saved.trimmingCharacters(in: .whitespacesAndNewlines)
            if id.hasPrefix("dev_"), id.count >= 12 { return id }
        }
        let id = "dev_" + Self.randomHex(20)
        try? id.write(to: deviceFile, atomically: true, encoding: .utf8)
        return id
    }

    private func loadQueue() -> [QueuedEvent] {
        guard let data = try? Data(contentsOf: queueFile) else { return [] }
        return (try? JSONDecoder().decode([QueuedEvent].self, from: data)) ?? []
    }

    private func persistIfNeeded() {
        guard dirty else { return }
        if pending.isEmpty { try? FileManager.default.removeItem(at: queueFile) }
        else if let data = try? JSONEncoder().encode(pending) { try? data.write(to: queueFile, options: .atomic) }
        dirty = false
    }

    // MARK: - helpers

    static func randomHex(_ count: Int) -> String {
        String(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(count))
    }

    /// Reads the local log's `t`: local time with an offset, with or without fractions.
    static func parse(_ text: String) -> Date? {
        if let d = formatter.date(from: text) { return d }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: text)
    }
}
