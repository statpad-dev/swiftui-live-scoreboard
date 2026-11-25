import Foundation

/// One entity as the server forwards it: a Statpad change, or a snapshot entity, which has no seq or op.
public struct Change: Decodable, Sendable {
    public let seq: Int?
    public let op: String?
    public let entityType: String
    public let entityId: String
    public let version: Int
    public let payload: Payload

    public enum Payload: Sendable, Equatable {
        case game(Game), liveState(LiveState), team(Team), play(Play), tombstone, other
    }

    enum CodingKeys: String, CodingKey { case seq, op, entityType, entityId, version, payload }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        seq = try c.decodeIfPresent(Int.self, forKey: .seq)
        op = try c.decodeIfPresent(String.self, forKey: .op)
        entityType = try c.decode(String.self, forKey: .entityType)
        entityId = try c.decode(String.self, forKey: .entityId)
        version = try c.decode(Int.self, forKey: .version)
        // A delete's payload is a tombstone (id, version, deleted_at), not the entity.
        if op == "delete" {
            payload = .tombstone
            return
        }
        switch entityType {
        case "game": payload = .game(try c.decode(Game.self, forKey: .payload))
        case "live_state": payload = .liveState(try c.decode(LiveState.self, forKey: .payload))
        case "team": payload = .team(try c.decode(Team.self, forKey: .payload))
        case "play": payload = .play(try c.decode(Play.self, forKey: .payload))
        default: payload = .other
        }
    }
}

public struct Snapshot: Decodable, Sendable {
    public let seq: Int
    public let entities: [Change]
}

public struct Game: Decodable, Sendable, Equatable {
    public let id: String
    public let status: String
    public let homeTeamId: String
    public let awayTeamId: String
    public let homeScore: Int?
    public let awayScore: Int?
}

public struct LiveState: Decodable, Sendable, Equatable {
    public let period: Int?
    /// Seconds left in the period, as of the last play. Football feeds have no running flag.
    public let clockSeconds: Int?
    public let clockRunning: Bool?
    public let possessionTeamId: String?
    public let homeScore: Int
    public let awayScore: Int
    public let lastPlayId: String?
    public let football: Football?

    public struct Football: Decodable, Sendable, Equatable {
        public let down: Int?
        public let yardsToGo: Int?
        /// The line of scrimmage, 0-100 from the possessing team's own goal line.
        public let yardline: Int?
    }
}

public struct Team: Decodable, Sendable, Equatable {
    public let id: String
    public let alias: String
    public let market: String
    public let name: String
}

public struct Play: Decodable, Sendable, Equatable {
    public let id: String
    public let sequence: Int
    public let version: Int
    public let type: String
    public let period: Int?
    public let clockSeconds: Int?
    public let description: String?
    public let isScoring: Bool?
}

extension JSONDecoder {
    /// Statpad's JSON is snake_case.
    public static func statpad() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }
}
