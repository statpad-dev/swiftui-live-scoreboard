import Foundation
import Observation
import os

/// Keeps a GameStore current from the server's event stream, resuming by seq after a drop.
@MainActor @Observable
public final class LiveFeed {
    public enum Status: Equatable { case connecting, live, reconnecting, offline }

    public let store = GameStore()
    public private(set) var status = Status.connecting
    private let url: URL
    private let connect: (URLRequest) -> AsyncThrowingStream<ServerEvent, any Error>
    private let decoder = JSONDecoder.statpad()
    private let logger = Logger(subsystem: "dev.statpad.scoreboard", category: "LiveFeed")

    /// `connect` opens the event stream for a request. Tests pass a stand-in for the server.
    public init(url: URL, connect: @escaping (URLRequest) -> AsyncThrowingStream<ServerEvent, any Error> = { serverEvents(for: $0) }) {
        self.url = url
        self.connect = connect
    }

    /// Runs until cancelled. Every request after the first carries the last applied seq as
    /// Last-Event-ID, and the server answers with what the phone missed.
    public func run() async {
        var attempt = 0
        while !Task.isCancelled {
            status = attempt == 0 ? .connecting : .reconnecting
            var request = URLRequest(url: url)
            if store.seq > 0 { request.setValue(String(store.seq), forHTTPHeaderField: "Last-Event-ID") }
            do {
                for try await event in connect(request) {
                    let data = Data(event.data.utf8)
                    switch event.event {
                    case "open":
                        status = .live
                        attempt = 0
                    case "snapshot":
                        store.load(try decoder.decode(Snapshot.self, from: data))
                    case "changes":
                        store.apply(try decoder.decode([Change].self, from: data), through: Int(event.id ?? "") ?? store.seq)
                    default:
                        break
                    }
                }
            } catch {
                logger.error("event stream ended at seq \(self.store.seq): \(error.localizedDescription, privacy: .public)")
            }
            if Task.isCancelled { break }
            attempt += 1
            status = .reconnecting
            // Up to 30 seconds, with jitter, so phones cut off together don't all return together.
            let seconds = Double(min(30, 1 << min(attempt, 5))) * Double.random(in: 0.5...1)
            try? await Task.sleep(for: .seconds(seconds))
        }
        status = .offline
    }
}
