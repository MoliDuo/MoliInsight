import Foundation

/// A JSON value that can be stored and sent. Event fields are converted into
/// this on the way in, so what is queued is always valid JSON.
public enum JSONValue: Codable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case null
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }

    /// Converts what a logger has at hand. Returns nil for what JSON cannot hold.
    public init?(any value: Any) {
        // Swift's own types first: `Bool` must not be read as a number.
        switch value {
        case let v as String: self = .string(v)
        case let v as Bool where type(of: value) == Bool.self: self = .bool(v)
        case let v as Int: self = .number(Double(v))
        case let v as Double:
            guard v.isFinite else { return nil }
            self = .number(v)
        case is NSNull: self = .null
        case let v as NSNumber:
            // What JSONSerialization or Objective-C hands over. A boolean's type encoding is "c".
            if String(cString: v.objCType) == "c" { self = .bool(v.boolValue) }
            else if v.doubleValue.isFinite { self = .number(v.doubleValue) }
            else { return nil }
        case let v as [Any]: self = .array(v.compactMap { JSONValue(any: $0) })
        case let v as [String: Any]:
            var out: [String: JSONValue] = [:]
            for (key, inner) in v {
                if let converted = JSONValue(any: inner) { out[InsightKey.sanitize(key)] = converted }
            }
            self = .object(out)
        default: return nil
        }
    }
}

enum InsightKey {
    /// The server accepts keys of `^[A-Za-z_][A-Za-z0-9_]{0,63}$`; anything else would reject the whole event.
    static func sanitize(_ key: String) -> String {
        var chars = key.unicodeScalars.map { s -> Character in
            (s.isASCII && (CharacterSet.alphanumerics.contains(s) || s == "_")) ? Character(s) : "_"
        }
        if chars.isEmpty { chars = ["_"] }
        if let first = chars.first, first.isNumber { chars.insert("_", at: 0) }
        return String(chars.prefix(64))
    }
}
