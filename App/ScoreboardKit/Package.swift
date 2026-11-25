// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "ScoreboardKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "ScoreboardKit", targets: ["ScoreboardKit"])],
    targets: [
        .target(name: "ScoreboardKit"),
        .testTarget(name: "ScoreboardKitTests", dependencies: ["ScoreboardKit"]),
    ]
)
