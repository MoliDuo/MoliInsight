// swift-tools-version: 5.9
import PackageDescription

// A small client for MoliInsight's ingest API, for native programs that have no
// backend of their own (direct mode). Copy it into the app or add it as a
// local package; it is not published.
let package = Package(
    name: "MoliInsight",
    platforms: [.macOS(.v12)],
    products: [.library(name: "MoliInsight", targets: ["MoliInsight"])],
    targets: [
        .target(name: "MoliInsight"),
        .testTarget(name: "MoliInsightTests", dependencies: ["MoliInsight"]),
    ]
)
