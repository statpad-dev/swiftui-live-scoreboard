import Foundation

public struct ServerEvent: Sendable, Equatable {
    public var id: String?
    public var event = "message"
    public var data = ""

    public init(id: String? = nil, event: String = "message", data: String = "") {
        self.id = id
        self.event = event
        self.data = data
    }
}

/// Server-sent events over URLSession, starting with an "open" event once the server answers 200.
public func serverEvents(for request: URLRequest, session: URLSession = .shared) -> AsyncThrowingStream<ServerEvent, any Error> {
    AsyncThrowingStream { continuation in
        let task = Task {
            do {
                let (bytes, response) = try await session.bytes(for: request)
                guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
                continuation.yield(ServerEvent(event: "open"))
                try await readEvents(from: bytes) { continuation.yield($0) }
                continuation.finish()
            } catch {
                continuation.finish(throwing: error)
            }
        }
        continuation.onTermination = { _ in task.cancel() }
    }
}

/// Splits a server-sent event stream into events. `bytes.lines` would be shorter, but it skips
/// empty lines, and an empty line is what ends an event, so this splits the bytes itself.
/// Comment lines, such as the server's `: ping`, have no field name and are ignored.
public func readEvents<Bytes: AsyncSequence>(from bytes: Bytes, _ yield: (ServerEvent) -> Void) async throws where Bytes.Element == UInt8 {
    var line: [UInt8] = []
    var event = ServerEvent()
    for try await byte in bytes {
        if byte != UInt8(ascii: "\n") {
            line.append(byte)
            continue
        }
        let text = String(decoding: line, as: UTF8.self)
        line.removeAll(keepingCapacity: true)
        if text.isEmpty {
            if !event.data.isEmpty { yield(event) }
            event = ServerEvent()
            continue
        }
        let parts = text.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        let value = parts.count > 1 ? String(parts[1].hasPrefix(" ") ? parts[1].dropFirst() : parts[1]) : ""
        switch parts[0] {
        case "id": event.id = value
        case "event": event.event = value
        case "data": event.data += event.data.isEmpty ? value : "\n" + value
        default: break
        }
    }
}
