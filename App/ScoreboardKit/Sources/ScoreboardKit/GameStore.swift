import Observation

/// Everything the scoreboard draws, keyed the way Statpad keys it.
@MainActor @Observable
public final class GameStore {
    public private(set) var seq = 0
    public private(set) var game: Game?
    public private(set) var live: LiveState?
    public private(set) var teams: [String: Team] = [:]
    public private(set) var plays: [String: Play] = [:]

    public init() {}

    /// The server sends a snapshot on first connect, when it can't fill the gap since Last-Event-ID,
    /// and mid-stream after it reads the game from Statpad again. It replaces everything held.
    public func load(_ snapshot: Snapshot) {
        game = nil
        live = nil
        teams = [:]
        plays = [:]
        apply(snapshot.entities, through: snapshot.seq)
    }

    /// Applies one event's changes in order, with no suspension point between them. Each upsert
    /// carries the entity's full state, so a revised play replaces the row held under its id.
    public func apply(_ changes: [Change], through seq: Int) {
        for change in changes {
            switch change.payload {
            case .game(let game): self.game = game
            case .liveState(let live): self.live = live
            case .team(let team): teams[team.id] = team
            case .play(let play): plays[play.id] = play
            case .tombstone: delete(change.entityType, change.entityId)
            case .other: break
            }
        }
        self.seq = seq
    }

    private func delete(_ entityType: String, _ id: String) {
        switch entityType {
        case "game" where game?.id == id: game = nil
        case "live_state" where game?.id == id: live = nil
        case "team": teams[id] = nil
        case "play": plays[id] = nil
        default: break
        }
    }

    public var away: Team? { game.flatMap { teams[$0.awayTeamId] } }
    public var home: Team? { game.flatMap { teams[$0.homeTeamId] } }
    public var recentPlays: [Play] { Array(plays.values.sorted { $0.sequence > $1.sequence }.prefix(5)) }
}
