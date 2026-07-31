// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "OpenCodexMac",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "OpenCodex", targets: ["OpenCodex"]),
        .executable(name: "OpenCodexLivePicker", targets: ["OpenCodexLivePicker"])
    ],
    targets: [
        .executableTarget(
            name: "OpenCodex",
            dependencies: ["OpenCodexSecurity"],
            resources: [.process("Resources")]
        ),
        .executableTarget(name: "OpenCodexLivePicker", dependencies: ["OpenCodexSecurity"]),
        .target(name: "OpenCodexSecurity")
    ]
)
