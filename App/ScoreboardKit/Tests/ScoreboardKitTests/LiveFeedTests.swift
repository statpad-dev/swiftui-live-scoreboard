import Foundation
import Testing
@testable import ScoreboardKit

/// One server event carrying the recorded changes in `seqs`, as the server sends them.
func changesEvent(_ seqs: ClosedRange<Int>) -> ServerEvent {
    ServerEvent(id: String(seqs.upperBound), event: "changes", data: "[" + lines[(seqs.lowerBound - 1)..<seqs.upperBound].joined(separator: ",") + "]")
}

@MainActor
struct LiveFeedTests {
    @Test(.timeLimit(.minutes(1)))
    func aReconnectResumesFromTheLastAppliedSeq() async throws {
        var requests: [URLRequest] = []
        let feed = LiveFeed(url: URL(string: "http://127.0.0.1:8787/games/01a1d60f-67be-7bdd-83f4-53286521d9bb/events")!) { request in
            requests.append(request)
            return AsyncThrowingStream { continuation in
                continuation.yield(ServerEvent(event: "open"))
                if requests.count == 1 {
                    // The phone reaches 1101, then loses the connection.
                    continuation.yield(changesEvent(1...1101))
                    continuation.finish(throwing: URLError(.networkConnectionLost))
                } else {
                    // What the server sends a phone that comes back with Last-Event-ID: 1101.
                    continuation.yield(changesEvent(1102...1114))
                }
            }
        }
        let run = Task { await feed.run() }
        defer { run.cancel() }
        while feed.store.seq < 1114 { try await Task.sleep(for: .milliseconds(20)) }

        #expect(requests.map { $0.value(forHTTPHeaderField: "Last-Event-ID") } == [nil, "1101"])
        #expect(feed.status == .live)
        let touchdowns = feed.store.plays.values.filter { $0.description?.hasPrefix("J.Cook up the middle for 5 yards, TOUCHDOWN.") == true }
        #expect(touchdowns.count == 1)
        #expect(touchdowns.first?.version == 2)
        #expect(feed.store.game?.awayScore == 20)
    }
}
