// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "OpenCodexMac",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "CodexSplit", targets: ["OpenCodex"])
    ],
    targets: [
        .executableTarget(
            name: "OpenCodex",
            resources: [.process("Resources")]
        )
    ]
)
