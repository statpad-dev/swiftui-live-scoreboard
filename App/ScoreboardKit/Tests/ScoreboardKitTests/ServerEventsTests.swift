import Foundation
import Testing
@testable import ScoreboardKit

func bytes(_ text: String) -> AsyncStream<UInt8> {
    AsyncStream { continuation in
        for byte in text.utf8 { continuation.yield(byte) }
        continuation.finish()
    }
}

func events(in text: String) async throws -> [ServerEvent] {
    var events: [ServerEvent] = []
    try await readEvents(from: bytes(text)) { events.append($0) }
    return events
}

struct ServerEventsTests {
    /// Two events, six lines, two of them the empty lines that end an event.
    let twoEvents = "id: 1\ndata: a\n\nid: 2\ndata: b\n\n"

    @Test func linesSkipsTheEmptyLinesThatEndEvents() async throws {
        let file = FileManager.default.temporaryDirectory.appending(path: "\(UUID()).txt")
        try Data(twoEvents.utf8).write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }

        var lines: [String] = []
        for try await line in try await URLSession.shared.bytes(for: URLRequest(url: file)).0.lines { lines.append(line) }
        #expect(lines == ["id: 1", "data: a", "id: 2", "data: b"])

        var events: [ServerEvent] = []
        try await readEvents(from: URLSession.shared.bytes(for: URLRequest(url: file)).0) { events.append($0) }
        #expect(events == [ServerEvent(id: "1", data: "a"), ServerEvent(id: "2", data: "b")])
    }

    @Test func fieldsBuildOneEventPerEmptyLine() async throws {
        let text = "event: changes\nid: 1114\ndata: [1,\ndata: 2]\n\nevent: snapshot\nid: 1277\ndata:{}\n\n"
        #expect(try await events(in: text) == [
            ServerEvent(id: "1114", event: "changes", data: "[1,\n2]"),
            ServerEvent(id: "1277", event: "snapshot", data: "{}"),
        ])
    }

    @Test func pingsAndUnfinishedEventsAreNotEvents() async throws {
        #expect(try await events(in: ": ping\n\nevent: changes\nid: 7\n\ndata: cut off").isEmpty)
    }
}
