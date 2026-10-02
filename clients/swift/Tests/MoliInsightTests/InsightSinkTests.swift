import XCTest
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import MoliInsight

/// Answers from a script and keeps what it was sent.
final class FakeTransport: InsightTransport {
    var script: [Result<InsightResponse, Error>] = []
    private(set) var requests: [URLRequest] = []
    private let lock = NSLock()

    func send(_ request: URLRequest, completion: @escaping (Result<InsightResponse, Error>) -> Void) {
        lock.lock()
        requests.append(request)
        let next = script.isEmpty ? Result<InsightResponse, Error>.success(InsightResponse(status: 200)) : script.removeFirst()
        lock.unlock()
        completion(next)
    }

    func bodies() -> [[String: Any]] {
        lock.lock(); defer { lock.unlock() }
        return requests.compactMap { r in
            (try? JSONSerialization.jsonObject(with: r.httpBody ?? Data())) as? [String: Any]
        }
    }

    func eventNames() -> [String] {
        bodies().flatMap { ($0["events"] as? [[String: Any]] ?? []).compactMap { $0["name"] as? String } }
    }
}

final class InsightSinkTests: XCTestCase {
    var directory: URL!
    var transport: FakeTransport!
    var clock = Date(timeIntervalSince1970: 1_790_920_000) // 2026-10-02
    var config: InsightConfig!

    override func setUp() {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("moli-insight-\(UUID().uuidString)")
        transport = FakeTransport()
        config = InsightConfig(endpoint: URL(string: "https://insight.test")!, key: "mi_testkey", release: "0.2.57")
        config.flushInterval = 3600 // the tests flush by hand
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
    }

    private func makeSink(_ config: InsightConfig? = nil) -> InsightSink {
        InsightSink(config: config ?? self.config, directory: directory, transport: transport, now: { self.clock })
    }

    private func flush(_ sink: InsightSink) {
        let done = expectation(description: "flushed")
        sink.flush { done.fulfill() }
        wait(for: [done], timeout: 5)
    }

    func testSendsAValidBatchWithTheKeyAndContext() throws {
        let sink = makeSink()
        sink.start()
        sink.record("switch", fields: ["app": "com.apple.Safari", "ms": 3.2, "ok": true], mono: 84221907.5)
        flush(sink)

        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.url?.absoluteString, "https://insight.test/v1/ingest")
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer mi_testkey")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")

        let body = try XCTUnwrap(transport.bodies().first)
        XCTAssertEqual(body["schemaVersion"] as? Int, 1)
        let context = try XCTUnwrap(body["context"] as? [String: Any])
        XCTAssertEqual(context["platform"] as? String, "macos")
        XCTAssertEqual(context["release"] as? String, "0.2.57")
        XCTAssertEqual(context["deviceClass"] as? String, "desktop")
        XCTAssertTrue((context["deviceId"] as? String ?? "").hasPrefix("dev_"))

        let events = try XCTUnwrap(body["events"] as? [[String: Any]])
        XCTAssertEqual(events.map { $0["name"] as? String }, ["$session_start", "switch"])
        XCTAssertEqual(events[0]["props"] as? [String: String], ["navType": "launch"])
        let sw = events[1]
        XCTAssertEqual(sw["mono"] as? Double, 84221907.5)
        let props = try XCTUnwrap(sw["props"] as? [String: Any])
        XCTAssertEqual(props["app"] as? String, "com.apple.Safari")
        XCTAssertEqual(props["ms"] as? Double, 3.2)
        XCTAssertEqual(props["ok"] as? Bool, true)
        XCTAssertEqual(events[0]["sessionId"] as? String, sw["sessionId"] as? String)
        XCTAssertTrue((sw["occurredAt"] as? String ?? "").hasSuffix("Z"))
        XCTAssertTrue((sw["id"] as? String ?? "").count == 36)
    }

    func testKeepsOneDeviceIdAcrossRunsAndANewSessionPerRun() throws {
        let first = makeSink(); first.start(); flush(first)
        let second = makeSink(); second.start(); flush(second)
        let contexts = transport.bodies().compactMap { $0["context"] as? [String: Any] }
        XCTAssertEqual(contexts[0]["deviceId"] as? String, contexts[1]["deviceId"] as? String)
        let sessions = transport.bodies().compactMap { ($0["events"] as? [[String: Any]])?.first?["sessionId"] as? String }
        XCTAssertEqual(sessions.count, 2)
        XCTAssertNotEqual(sessions[0], sessions[1])
    }

    func testOnlySendsWhatIsIncludedAndNeverWhatIsExcluded() {
        config.include = ["switch", "manualSwitch"]
        config.exclude = ["manualSwitch"]
        let sink = makeSink(config)
        sink.start()
        for name in ["switch", "key", "diag", "manualSwitch", "snapshot"] { sink.record(name) }
        flush(sink)
        XCTAssertEqual(transport.eventNames(), ["$session_start", "switch"])
    }

    func testKeepsEventsWhenTheServerFailsAndSendsThemLater() {
        transport.script = [.success(InsightResponse(status: 503))]
        let sink = makeSink()
        sink.start()
        sink.record("switch")
        flush(sink) // fails
        XCTAssertEqual(transport.requests.count, 1)

        clock.addTimeInterval(20)
        flush(sink)
        XCTAssertEqual(transport.requests.count, 2)
        XCTAssertEqual(transport.eventNames().suffix(2), ["$session_start", "switch"])
    }

    func testBacksOffOnAFailureAndOnlyAnExplicitFlushIgnoresIt() {
        transport.script = [.failure(URLError(.notConnectedToInternet))]
        let sink = makeSink()
        sink.start()
        sink.record("a")
        flush(sink)
        XCTAssertEqual(transport.requests.count, 1)
        // The timer path respects the pause: record() under 50 events does not send.
        sink.record("b")
        flush(sink) // explicit flush forces an attempt
        XCTAssertEqual(transport.requests.count, 2)
    }

    func testKeepsTheQueueOnA401AndOn429() {
        transport.script = [.success(InsightResponse(status: 401)), .success(InsightResponse(status: 429, retryAfter: 120))]
        let sink = makeSink()
        sink.start()
        sink.record("a")
        flush(sink)
        flush(sink)
        flush(sink)
        XCTAssertEqual(transport.requests.count, 3)
        XCTAssertTrue(transport.eventNames().suffix(2).contains("a"))
    }

    func testDropsABatchTheServerRefusesForGood() {
        transport.script = [.success(InsightResponse(status: 400))]
        let sink = makeSink()
        sink.start()
        sink.record("a")
        flush(sink)
        flush(sink)
        XCTAssertEqual(transport.requests.count, 1)
    }

    func testSurvivesARestartWithTheQueueOnDisk() {
        transport.script = [.success(InsightResponse(status: 503))]
        let first = makeSink()
        first.start()
        first.record("kept")
        flush(first)
        XCTAssertEqual(transport.requests.count, 1)

        let second = makeSink()
        second.start()
        flush(second)
        XCTAssertTrue(transport.eventNames().suffix(3).contains("kept"))

        let third = makeSink()
        third.start()
        flush(third)
        let all = transport.eventNames()
        XCTAssertEqual(all.filter { $0 == "kept" }.count, 2, "sent once in the failed attempt, once in the retry, never again")
    }

    func testTurningItOffStopsAndForgetsTheQueue() {
        let sink = makeSink()
        sink.start()
        sink.record("a")
        sink.setEnabled(false)
        sink.record("b")
        flush(sink)
        XCTAssertEqual(transport.requests.count, 0)
        sink.setEnabled(true)
        sink.record("c")
        flush(sink)
        XCTAssertEqual(transport.eventNames(), ["c"])
    }

    func testRewritesKeysTheServerWouldRefuseAndDropsWhatJSONCannotHold() throws {
        let sink = makeSink()
        sink.start()
        sink.record("setting", fields: [
            "name": "x", "bad-key": 1, "9lives": 2, "inner": ["a b": "c"], "nan": Double.nan, "date": Date(),
        ])
        flush(sink)
        let events = try XCTUnwrap(transport.bodies().first?["events"] as? [[String: Any]])
        let props = try XCTUnwrap(events.last?["props"] as? [String: Any])
        XCTAssertEqual(Set(props.keys), ["name", "bad_key", "_9lives", "inner"])
        XCTAssertEqual((props["inner"] as? [String: Any])?["a_b"] as? String, "c")
    }

    func testMapsALocalLogLine() throws {
        let sink = makeSink()
        sink.start()
        sink.record(logLine: ["t": "2026-10-02T14:03:21.018+08:00", "mono": 84224350.1, "e": "manualSwitch", "sinceFocusMs": 2410.6, "app": "x"])
        flush(sink)
        let events = try XCTUnwrap(transport.bodies().first?["events"] as? [[String: Any]])
        let event = try XCTUnwrap(events.last)
        XCTAssertEqual(event["name"] as? String, "manualSwitch")
        XCTAssertEqual(event["occurredAt"] as? String, "2026-10-02T06:03:21.018Z")
        XCTAssertEqual(event["mono"] as? Double, 84224350.1)
        XCTAssertEqual((event["props"] as? [String: Any])?["sinceFocusMs"] as? Double, 2410.6)
    }

    func testKeepsAtMostMaxQueuedAndSplitsBatches() {
        config.maxQueued = 250
        let sink = makeSink(config)
        sink.start()
        transport.script = [.success(InsightResponse(status: 503))]
        sink.record("first")
        flush(sink)
        for i in 0..<400 { sink.record("e\(i)") }
        flush(sink)
        let sizes = transport.bodies().map { ($0["events"] as? [Any])?.count ?? 0 }
        XCTAssertTrue(sizes.allSatisfy { $0 <= 100 })
        XCTAssertFalse(transport.eventNames().suffix(250).contains("first"))
        XCTAssertEqual(transport.eventNames().suffix(250).count, 250)
    }
}
