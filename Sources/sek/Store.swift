import CryptoKit
import Foundation
import LocalAuthentication
import Security

struct SekError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

enum Paths {
    static let root: URL = {
        if let dir = ProcessInfo.processInfo.environment["SEK_DIR"], !dir.isEmpty {
            return URL(fileURLWithPath: (dir as NSString).expandingTildeInPath)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".sek")
    }()

    static let key = root.appendingPathComponent("enclave.key")
    static let publicKey = root.appendingPathComponent("public.key")
    static let config = root.appendingPathComponent("config.json")
    static let secrets = root.appendingPathComponent("secrets")
    static let socket = root.appendingPathComponent("agent.sock")
    static let agentLog = root.appendingPathComponent("agent.log")
}

struct Config: Codable {
    var version = 1
    var requireAuth: Bool
}

/// One encrypted secret on disk: ECIES-style envelope to the Secure Enclave key.
struct Record: Codable {
    let v: Int
    let epk: String // ephemeral P-256 public key (raw), base64
    let box: String // AES-GCM combined (nonce + ciphertext + tag), base64
}

func ensureDirectory(_ url: URL) throws {
    try FileManager.default.createDirectory(
        at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    chmod(url.path, 0o700)
}

/// Writes atomically with 0600 permissions.
func writePrivate(_ data: Data, to url: URL) throws {
    let tmp = url.deletingLastPathComponent()
        .appendingPathComponent(".\(url.lastPathComponent).\(getpid()).tmp")
    guard FileManager.default.createFile(
        atPath: tmp.path, contents: data, attributes: [.posixPermissions: 0o600])
    else { throw SekError("could not write \(tmp.path)") }
    guard rename(tmp.path, url.path) == 0 else {
        let reason = String(cString: strerror(errno))
        unlink(tmp.path)
        throw SekError("could not write \(url.path): \(reason)")
    }
}

private func deriveKey(_ shared: SharedSecret, epk: Data, recipient: Data, name: String) -> SymmetricKey {
    shared.hkdfDerivedSymmetricKey(
        using: SHA256.self,
        salt: epk + recipient,
        sharedInfo: Data("sek/v1/\(name)".utf8),
        outputByteCount: 32)
}

enum Store {
    static func requireInitialized() throws {
        guard FileManager.default.fileExists(atPath: Paths.key.path) else {
            throw SekError("not initialized; run `sek init` first")
        }
    }

    static func config() throws -> Config {
        try JSONDecoder().decode(Config.self, from: Data(contentsOf: Paths.config))
    }

    static func accessControl(requireAuth: Bool) throws -> SecAccessControl {
        var flags: SecAccessControlCreateFlags = [.privateKeyUsage]
        if requireAuth { flags.insert(.userPresence) }
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
            nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, flags, &error)
        else {
            throw SekError("could not create access control: \(error!.takeRetainedValue())")
        }
        return access
    }

    static func initialize(requireAuth: Bool) throws {
        guard SecureEnclave.isAvailable else { throw SekError("this Mac has no Secure Enclave") }
        if FileManager.default.fileExists(atPath: Paths.key.path) {
            throw SekError("already initialized at \(Paths.root.path)")
        }
        if let existing = try? FileManager.default.contentsOfDirectory(atPath: Paths.root.path),
           !existing.isEmpty {
            throw SekError("\(Paths.root.path) already exists and is not empty")
        }
        try ensureDirectory(Paths.root)
        try ensureDirectory(Paths.secrets)
        let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(
            accessControl: accessControl(requireAuth: requireAuth))
        try writePrivate(key.dataRepresentation, to: Paths.key)
        try writePrivate(key.publicKey.rawRepresentation, to: Paths.publicKey)
        try writePrivate(JSONEncoder().encode(Config(requireAuth: requireAuth)), to: Paths.config)
    }

    static func validate(_ name: String) throws {
        let allowed = name.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "_.-".contains($0)) }
        guard !name.isEmpty, name.count <= 128, allowed, !name.hasPrefix(".") else {
            throw SekError("invalid secret name '\(name)' (use letters, digits, _ . -)")
        }
    }

    static func url(for name: String) -> URL {
        Paths.secrets.appendingPathComponent(name + ".sek")
    }

    static func names() throws -> [String] {
        try requireInitialized()
        let files = (try? FileManager.default.contentsOfDirectory(atPath: Paths.secrets.path)) ?? []
        return files.filter { $0.hasSuffix(".sek") && !$0.hasPrefix(".") }
            .map { String($0.dropLast(4)) }
            .sorted()
    }

    /// The stored name that differs from `name` only by case. The disk is usually
    /// case-insensitive, so `Foo` and `foo` would otherwise share one file.
    static func caseConflict(_ name: String) throws -> String? {
        try names().first { $0 != name && $0.lowercased() == name.lowercased() }
    }

    static func exists(_ name: String) throws -> Bool {
        try names().contains(name)
    }

    /// Encrypting needs only the public key, so it never prompts.
    static func seal(_ value: Data, as name: String) throws {
        try requireInitialized()
        try validate(name)
        if let other = try caseConflict(name) {
            throw SekError("'\(other)' already exists; names differing only in case aren't allowed")
        }
        let recipient = try P256.KeyAgreement.PublicKey(
            rawRepresentation: Data(contentsOf: Paths.publicKey))
        let ephemeral = P256.KeyAgreement.PrivateKey()
        let shared = try ephemeral.sharedSecretFromKeyAgreement(with: recipient)
        let epk = ephemeral.publicKey.rawRepresentation
        let key = deriveKey(shared, epk: epk, recipient: recipient.rawRepresentation, name: name)
        let box = try AES.GCM.seal(value, using: key, authenticating: Data(name.utf8))
        let record = Record(
            v: 1, epk: epk.base64EncodedString(), box: box.combined!.base64EncodedString())
        try ensureDirectory(Paths.secrets)
        try writePrivate(JSONEncoder().encode(record), to: url(for: name))
    }

    static func remove(_ name: String) throws -> Bool {
        try requireInitialized()
        try validate(name)
        let path = url(for: name).path
        guard try exists(name) else { return false }
        try FileManager.default.removeItem(atPath: path)
        return true
    }
}

/// Holds the Secure Enclave key with one authenticated LAContext, so a single
/// Touch ID / password prompt covers every decryption made through it.
final class Unlocker {
    private let key: SecureEnclave.P256.KeyAgreement.PrivateKey
    private let recipient: Data

    init(reason: String) throws {
        try Store.requireInitialized()
        let context = LAContext()
        context.localizedReason = reason
        if try Store.config().requireAuth {
            try Unlocker.evaluate(context, access: Store.accessControl(requireAuth: true), reason: reason)
        }
        key = try SecureEnclave.P256.KeyAgreement.PrivateKey(
            dataRepresentation: Data(contentsOf: Paths.key), authenticationContext: context)
        recipient = key.publicKey.rawRepresentation
        // Use the key once now so auth problems surface here, not mid-run.
        _ = try key.sharedSecretFromKeyAgreement(with: P256.KeyAgreement.PrivateKey().publicKey)
    }

    private static func evaluate(_ context: LAContext, access: SecAccessControl, reason: String) throws {
        let done = DispatchSemaphore(value: 0)
        var failure: Error?
        context.evaluateAccessControl(access, operation: .useKeyKeyExchange, localizedReason: reason) {
            ok, error in
            if !ok { failure = error ?? SekError("authentication failed") }
            done.signal()
        }
        done.wait()
        if let failure { throw SekError("authentication failed: \(failure.localizedDescription)") }
    }

    func open(_ name: String) throws -> Data {
        try Store.validate(name)
        guard try Store.exists(name), let raw = try? Data(contentsOf: Store.url(for: name)) else {
            throw SekError("no secret named '\(name)'")
        }
        guard let record = try? JSONDecoder().decode(Record.self, from: raw), record.v == 1,
              let epk = Data(base64Encoded: record.epk),
              let boxData = Data(base64Encoded: record.box)
        else { throw SekError("secret '\(name)' is corrupted") }
        let shared = try key.sharedSecretFromKeyAgreement(
            with: P256.KeyAgreement.PublicKey(rawRepresentation: epk))
        let symmetric = deriveKey(shared, epk: epk, recipient: recipient, name: name)
        do {
            return try AES.GCM.open(
                AES.GCM.SealedBox(combined: boxData), using: symmetric, authenticating: Data(name.utf8))
        } catch {
            throw SekError("secret '\(name)' could not be decrypted (different key or tampered file)")
        }
    }
}
