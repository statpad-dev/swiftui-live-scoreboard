import ScoreboardKit
import SwiftUI

extension Color {
    static let ink = Color(red: 0x0B / 255, green: 0x0B / 255, blue: 0x0B / 255)
    static let muted = Color(red: 0x60 / 255, green: 0x60 / 255, blue: 0x62 / 255)
    static let hairline = Color(red: 0xEC / 255, green: 0xEC / 255, blue: 0xEE / 255)
    static let accent = Color(red: 0x2F / 255, green: 0x5B / 255, blue: 0xEA / 255)
}

struct ScoreboardView: View {
    let store: GameStore
    let status: LiveFeed.Status

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                StatusLine(status: status, seq: store.seq)
                if let game = store.game, let away = store.away, let home = store.home {
                    VStack(spacing: 0) {
                        TeamRow(team: away, score: game.awayScore, hasBall: store.live?.possessionTeamId == away.id)
                        Rectangle().fill(Color.hairline).frame(height: 1)
                        TeamRow(team: home, score: game.homeScore, hasBall: store.live?.possessionTeamId == home.id)
                    }
                    if let live = store.live {
                        let offense = live.possessionTeamId == home.id ? home : away
                        let defense = offense.id == home.id ? away : home
                        SituationView(game: game, live: live, offense: offense, defense: defense)
                    }
                    PlaysView(plays: store.recentPlays)
                } else {
                    ProgressView().frame(maxWidth: .infinity)
                }
            }
            .padding(20)
        }
        .background(Color.white)
        .foregroundStyle(Color.ink)
    }
}

struct StatusLine: View {
    let status: LiveFeed.Status
    let seq: Int

    var body: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(status == .live ? Color.accent : Color.white)
                .stroke(status == .live ? Color.accent : Color.muted, lineWidth: 1.5)
                .frame(width: 9, height: 9)
            Text(label).font(.system(size: 13, weight: .medium))
            Spacer()
            Text(verbatim: "seq \(seq)").font(.system(size: 13, design: .monospaced)).foregroundStyle(Color.muted)
        }
    }

    var label: String {
        switch status {
        case .connecting: "Connecting"
        case .live: "Live"
        case .reconnecting: "Reconnecting"
        case .offline: "Offline"
        }
    }
}

struct TeamRow: View {
    let team: Team
    let score: Int?
    let hasBall: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(team.alias).font(.system(size: 22, weight: .semibold))
                Text("\(team.market) \(team.name)").font(.system(size: 13)).foregroundStyle(Color.muted)
            }
            Spacer()
            if hasBall {
                Image(systemName: "football.fill").font(.system(size: 14)).foregroundStyle(Color.accent)
            }
            Text(score.map(String.init) ?? "-")
                .font(.system(size: 52, weight: .semibold))
                .monospacedDigit()
                .frame(minWidth: 72, alignment: .trailing)
        }
        .padding(.vertical, 12)
    }
}

struct SituationView: View {
    let game: Game
    let live: LiveState
    let offense: Team
    let defense: Team

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                Text(period).font(.system(size: 17, weight: .semibold, design: .monospaced))
                Spacer()
                if let downAndDistance { Text(downAndDistance).font(.system(size: 17, weight: .medium)) }
            }
            if game.status != "complete" {
                Text("Clock as of the last play").font(.system(size: 12)).foregroundStyle(Color.muted)
            }
            if let yardline = live.football?.yardline, game.status == "inprogress" {
                FieldBar(yardline: yardline, toGo: live.football?.yardsToGo, offense: offense.alias, defense: defense.alias)
            }
        }
    }

    var period: String {
        switch game.status {
        case "complete", "closed": return "Final"
        case "halftime": return "Halftime"
        default:
            let clock = live.clockSeconds.map { String(format: "%d:%02d", $0 / 60, $0 % 60) } ?? ""
            return "Q\(live.period ?? 1)  \(clock)"
        }
    }

    var downAndDistance: String? {
        guard game.status == "inprogress", let f = live.football, let down = f.down, let toGo = f.yardsToGo, let yardline = f.yardline else { return nil }
        let ordinal = ["1st", "2nd", "3rd", "4th"][down - 1]
        let distance = yardline + toGo >= 100 ? "Goal" : String(toGo)
        let spot = yardline == 50 ? "50" : yardline > 50 ? "\(defense.alias) \(100 - yardline)" : "\(offense.alias) \(yardline)"
        return "\(ordinal) & \(distance) at \(spot)"
    }
}

/// yardline runs 0-100 from the offense's own goal line, so the bar is drawn from the
/// offense's goal on the left to the defense's on the right.
struct FieldBar: View {
    let yardline: Int
    let toGo: Int?
    let offense: String
    let defense: String

    var body: some View {
        VStack(spacing: 6) {
            GeometryReader { geo in
                let x = { (yards: Int) in geo.size.width * CGFloat(yards) / 100 }
                ZStack(alignment: .leading) {
                    Rectangle().fill(Color.hairline)
                    ForEach(1..<10, id: \.self) { i in
                        Rectangle().fill(Color.white).frame(width: 1).offset(x: x(i * 10))
                    }
                    if let toGo {
                        Rectangle().fill(Color.ink).frame(width: 2).offset(x: x(min(100, yardline + toGo)) - 1)
                    }
                    Circle().fill(Color.accent).frame(width: 14, height: 14).offset(x: x(yardline) - 7)
                }
            }
            .frame(height: 14)
            HStack {
                Text("\(offense) goal")
                Spacer()
                Text("yardline \(yardline)")
                Spacer()
                Text("\(defense) goal")
            }
            .font(.system(size: 11, design: .monospaced))
            .foregroundStyle(Color.muted)
        }
    }
}

struct PlaysView: View {
    let plays: [Play]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("PLAYS").font(.system(size: 11, weight: .semibold)).tracking(0.8).foregroundStyle(Color.muted).padding(.bottom, 8)
            ForEach(plays, id: \.id) { play in
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(clock(play)).font(.system(size: 12, design: .monospaced)).foregroundStyle(Color.muted).frame(width: 64, alignment: .leading)
                    VStack(alignment: .leading, spacing: 6) {
                        Text(play.description ?? play.type)
                            .font(.system(size: 15, weight: play.isScoring == true ? .semibold : .regular))
                            .fixedSize(horizontal: false, vertical: true)
                        if play.version > 1 {
                            Text("revision \(play.version)")
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(Color.muted)
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color.hairline))
                        }
                    }
                }
                .padding(.vertical, 10)
                .overlay(alignment: .leading) {
                    if play.isScoring == true { Rectangle().fill(Color.accent).frame(width: 3).offset(x: -20) }
                }
                Rectangle().fill(Color.hairline).frame(height: 1)
            }
        }
    }

    func clock(_ play: Play) -> String {
        let clock = play.clockSeconds.map { String(format: "%d:%02d", $0 / 60, $0 % 60) } ?? ""
        return "Q\(play.period ?? 0) \(clock)"
    }
}
