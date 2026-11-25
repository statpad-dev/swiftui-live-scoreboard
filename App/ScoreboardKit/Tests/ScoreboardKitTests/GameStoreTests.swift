import Foundation
import Testing
@testable import ScoreboardKit

// The recorded Bills at Vikings game from statpad.dev/samples: 1,277 changes, seq 1 to 1277.
let samples = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "../../../../data/nfl-bills-at-vikings")
let lines = try! String(contentsOf: samples.appending(path: "changes.ndjson"), encoding: .utf8).split(separator: "\n")
let journal: [Change] = lines.map { try! JSONDecoder.statpad().decode(Change.self, from: Data($0.utf8)) }

func changes(_ seqs: ClosedRange<Int>) -> [Change] { journal.filter { seqs.contains($0.seq!) } }

struct GameRead: Decodable {
    let game: Game
    let liveState: LiveState
    let seq: Int
}

@MainActor
func store(applying ranges: ClosedRange<Int>...) -> GameStore {
    let store = GameStore()
    for range in ranges { store.apply(changes(range), through: range.upperBound) }
    return store
}

@MainActor
func sameState(_ a: GameStore, _ b: GameStore) -> Bool {
    a.seq == b.seq && a.game == b.game && a.live == b.live && a.teams == b.teams && a.plays == b.plays
}

@MainActor
struct GameStoreTests {
    @Test func everyChangeReachesTheFinalGameRead() throws {
        let final = try JSONDecoder.statpad().decode(GameRead.self, from: Data(contentsOf: samples.appending(path: "game.json")))
        let store = store(applying: 1...1277)
        #expect(store.seq == final.seq)
        #expect(store.game == final.game)
        #expect(store.live == final.liveState)
        #expect(store.game?.status == "complete")
        #expect(store.game?.awayScore == 23 && store.game?.homeScore == 6)
        #expect(store.plays.count == 187)
    }

    @Test func applyingEverythingTwiceIsHarmless() {
        #expect(sameState(store(applying: 1...1277, 1...1277), store(applying: 1...1277)))
    }

    @Test func resumingAfter1101MatchesOneUnbrokenRun() throws {
        let live = try JSONDecoder.statpad().decode(GameRead.self, from: Data(contentsOf: samples.appending(path: "game-live.json")))
        let atDrop = store(applying: 1...1101)
        #expect(atDrop.game == live.game)
        #expect(atDrop.live == live.liveState)
        #expect(sameState(store(applying: 1...1101, 1102...1277), store(applying: 1...1277)))
    }

    @Test func theTouchdownIsOneRowWithItsExtraPoint() {
        let store = store(applying: 1...1101, 1102...1114)
        let touchdowns = store.plays.values.filter { $0.description?.hasPrefix("J.Cook up the middle for 5 yards, TOUCHDOWN.") == true }
        #expect(touchdowns.count == 1)
        #expect(touchdowns.first?.version == 2)
        #expect(touchdowns.first?.description?.contains("T.Bass extra point is GOOD") == true)
        #expect(store.game?.awayScore == 20)
    }

    @Test func aDeletedPlayLeavesTheBoard() throws {
        let store = store(applying: 1...1114)
        let touchdown = try #require(store.plays.values.first { $0.description?.hasPrefix("J.Cook up the middle for 5 yards, TOUCHDOWN.") == true })
        let count = store.plays.count
        // The recording has no deletes, so this tombstone is written by hand in the schema's shape.
        let tombstone = """
            {"seq":1115,"at":"2026-11-13T17:58:33.000000Z","op":"delete","entity_type":"play","entity_id":"\(touchdown.id)",\
            "version":3,"payload_version":1,"payload":{"id":"\(touchdown.id)","version":3,"deleted_at":"2026-11-10T04:06:00Z"}}
            """
        store.apply([try JSONDecoder.statpad().decode(Change.self, from: Data(tombstone.utf8))], through: 1115)
        #expect(store.plays[touchdown.id] == nil)
        #expect(store.plays.count == count - 1)
        #expect(store.seq == 1115)
    }

    @Test func aSnapshotMidStreamReplacesEverything() throws {
        let final = try JSONDecoder.statpad().decode(GameRead.self, from: Data(contentsOf: samples.appending(path: "game.json")))
        let store = store(applying: 1...1114)
        let touchdown = try #require(store.plays.values.first { $0.description?.hasPrefix("J.Cook up the middle for 5 yards, TOUCHDOWN.") == true })
        // What the server sends after a resync: each entity's last version at 1277, here without
        // the touchdown, as if Statpad had deleted it while the server was away.
        var latest: [String: Substring] = [:]
        for (change, line) in zip(journal, lines) where ["game", "live_state", "team", "play"].contains(change.entityType) && change.entityId != touchdown.id {
            latest["\(change.entityType):\(change.entityId)"] = line
        }
        let snapshot = "{\"seq\":1277,\"entities\":[\(latest.values.joined(separator: ","))]}"
        store.load(try JSONDecoder.statpad().decode(Snapshot.self, from: Data(snapshot.utf8)))
        #expect(store.seq == 1277)
        #expect(store.game == final.game)
        #expect(store.live == final.liveState)
        #expect(store.plays[touchdown.id] == nil)
        #expect(store.plays.count == 186)
    }
}
