import ScoreboardKit
import SwiftUI

@main
struct ScoreboardApp: App {
    // Bills at Vikings, November 9, 2026, the recorded game the server replays. SCOREBOARD_SERVER
    // points the app at another server, and SCOREBOARD_GAME at the game the server follows live.
    @State private var feed: LiveFeed = {
        let environment = ProcessInfo.processInfo.environment
        let server = environment["SCOREBOARD_SERVER"] ?? "http://127.0.0.1:8787"
        let game = environment["SCOREBOARD_GAME"] ?? "01a1d60f-67be-7bdd-83f4-53286521d9bb"
        return LiveFeed(url: URL(string: "\(server)/games/\(game)/events")!)
    }()

    var body: some Scene {
        WindowGroup {
            ScoreboardView(store: feed.store, status: feed.status)
                .task { await feed.run() }
        }
        .defaultSize(width: 430, height: 820)
    }
}
