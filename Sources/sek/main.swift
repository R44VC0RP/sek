import Darwin
import Foundation

let usage = """
sek: API keys encrypted by this Mac's Secure Enclave

  sek init [--no-auth]            create the Secure Enclave key
                                  (asks for Touch ID or your password on use, unless --no-auth)
  sek set NAME                    store a secret (prompts, or reads stdin)
  sek get NAME                    print a secret
  sek list                        list secret names
  sek rm NAME                     delete a secret
  sek run [-e FILE]... [--] CMD   run CMD with every sek://NAME value resolved,
                                  from the environment and any --env-file
  sek unlock [--ttl 1h]           unlock once for a session; locks on expiry, screen lock or sleep
  sek lock                        end the session now
  sek status                      show whether a session is unlocked

In a .env file:  OPENAI_API_KEY=sek://OPENAI_API_KEY
Data lives in ~/.sek (override with SEK_DIR). Agent access log: ~/.sek/agent.log
"""

/// Fetches secrets through the unlocked agent when there is one, otherwise with
/// one direct prompt for all secrets in this process.
final class Resolver {
    private let reason: String
    private var unlocker: Unlocker?
    private var agentAvailable = true

    init(reason: String) { self.reason = reason }

    func value(_ name: String) throws -> Data {
        try Store.validate(name)
        if agentAvailable {
            if let response = AgentClient.send(AgentRequest(op: "get", name: name)) {
                guard response.ok, let value = response.value.flatMap({ Data(base64Encoded: $0) }) else {
                    throw SekError(response.error ?? "agent error")
                }
                return value
            }
            agentAvailable = false
        }
        if unlocker == nil { unlocker = try Unlocker(reason: reason) }
        return try unlocker!.open(name)
    }
}

enum EnvFile {
    static func parse(_ path: String) throws -> [(String, String)] {
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
            throw SekError("cannot read env file \(path)")
        }
        var entries: [(String, String)] = []
        for raw in text.split(whereSeparator: \.isNewline) {
            var line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") { continue }
            if line.hasPrefix("export ") { line = line.dropFirst(7).trimmingCharacters(in: .whitespaces) }
            guard let eq = line.firstIndex(of: "=") else { continue }
            let key = line[..<eq].trimmingCharacters(in: .whitespaces)
            guard !key.isEmpty, key.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_") })
            else { continue }
            var value = line[line.index(after: eq)...].trimmingCharacters(in: .whitespaces)
            if value.count >= 2, let quote = value.first, quote == "\"" || quote == "'", value.last == quote {
                value = String(value.dropFirst().dropLast())
            } else if let comment = value.range(of: " #") {
                value = value[..<comment.lowerBound].trimmingCharacters(in: .whitespaces)
            }
            entries.append((key, value))
        }
        return entries
    }
}

func readSecretValue(name: String) throws -> Data {
    if isatty(0) != 0 {
        var buffer = [CChar](repeating: 0, count: 16384)
        defer { buffer.withUnsafeMutableBytes { memset_s($0.baseAddress, $0.count, 0, $0.count) } }
        guard readpassphrase("Value for \(name): ", &buffer, buffer.count, 0) != nil else {
            throw SekError("could not read value")
        }
        return Data(String(cString: buffer).utf8)
    }
    var data = FileHandle.standardInput.readDataToEndOfFile()
    if data.last == 10 { data.removeLast() }
    if data.last == 13 { data.removeLast() }
    return data
}

func cmdRun(_ args: [String]) throws -> Never {
    var envFiles: [String] = []
    var index = 0
    while index < args.count {
        let arg = args[index]
        if arg == "--" {
            index += 1
            break
        } else if arg == "-e" || arg == "--env-file" {
            guard index + 1 < args.count else { throw SekError("\(arg) needs a file") }
            envFiles.append(args[index + 1])
            index += 2
        } else if arg.hasPrefix("--env-file=") {
            envFiles.append(String(arg.dropFirst("--env-file=".count)))
            index += 1
        } else {
            break
        }
    }
    let command = Array(args[index...])
    guard let program = command.first else { throw SekError("usage: sek run [-e FILE]... [--] CMD [ARGS...]") }

    var environment = ProcessInfo.processInfo.environment
    var changed = Set<String>()
    for file in envFiles {
        for (key, value) in try EnvFile.parse(file) {
            environment[key] = value
            changed.insert(key)
        }
    }

    let references = environment.filter { $0.value.hasPrefix("sek://") }.sorted { $0.key < $1.key }
    if !references.isEmpty {
        let resolver = Resolver(
            reason: "run \((program as NSString).lastPathComponent) with \(references.count) secret\(references.count == 1 ? "" : "s")")
        for (key, reference) in references {
            let name = String(reference.dropFirst("sek://".count))
            guard let value = String(data: try resolver.value(name), encoding: .utf8), !value.contains("\0") else {
                throw SekError("secret '\(name)' is not text, cannot put it in \(key)")
            }
            environment[key] = value
            changed.insert(key)
        }
    }

    for key in changed { setenv(key, environment[key]!, 1) }
    var argv: [UnsafeMutablePointer<CChar>?] = command.map { strdup($0) } + [nil]
    execvp(program, &argv)
    let reason = String(cString: strerror(errno))
    FileHandle.standardError.write(Data("sek: cannot run \(program): \(reason)\n".utf8))
    exit(127)
}

func requireName(_ args: [String], _ usage: String) throws -> String {
    guard args.count == 1 else { throw SekError("usage: \(usage)") }
    try Store.validate(args[0])
    return args[0]
}

func main() throws {
    signal(SIGPIPE, SIG_IGN)
    umask(0o077) // every file sek creates is private from the first byte
    var args = Array(CommandLine.arguments.dropFirst())
    guard !args.isEmpty else {
        print(usage)
        exit(1)
    }
    let command = args.removeFirst()

    switch command {
    case "init":
        let noAuth = args.contains("--no-auth")
        try Store.initialize(requireAuth: !noAuth)
        print("Created a Secure Enclave key in \(Paths.root.path)")
        print(noAuth
            ? "Secrets can be read without Touch ID (--no-auth)."
            : "Reading secrets will ask for Touch ID or your password.")

    case "set":
        let name = try requireName(args, "sek set NAME")
        try Store.requireInitialized()
        let existed = try Store.exists(name)
        var value = try readSecretValue(name: name)
        defer { value.resetBytes(in: 0..<value.count) }
        guard !value.isEmpty else { throw SekError("empty value, nothing stored") }
        try Store.seal(value, as: name)
        FileHandle.standardError.write(Data("\(existed ? "Updated" : "Stored") \(name)\n".utf8))

    case "get":
        let name = try requireName(args, "sek get NAME")
        try Store.requireInitialized()
        let value = try Resolver(reason: "read \(name)").value(name)
        FileHandle.standardOutput.write(value)
        if isatty(1) != 0 { FileHandle.standardOutput.write(Data("\n".utf8)) }

    case "list", "ls":
        for name in try Store.names() { print(name) }

    case "rm", "delete":
        let name = try requireName(args, "sek rm NAME")
        guard try Store.remove(name) else { throw SekError("no secret named '\(name)'") }
        FileHandle.standardError.write(Data("Deleted \(name)\n".utf8))

    case "run":
        try cmdRun(args)

    case "unlock":
        var ttl: TimeInterval = 3600
        if let i = args.firstIndex(of: "--ttl") {
            guard i + 1 < args.count else { throw SekError("--ttl needs a duration, e.g. 2h") }
            ttl = try parseDuration(args[i + 1])
        }
        guard ttl <= 86400 else { throw SekError("--ttl can be at most 24h") }
        FileHandle.standardError.write(Data("Waiting for Touch ID or your password…\n".utf8))
        let expires = try AgentClient.start(ttl: ttl)
        print("Unlocked until \(expires.formatted(date: .omitted, time: .shortened)) (\(formatDuration(expires.timeIntervalSinceNow))). Locks early if the screen locks or the Mac sleeps.")

    case "lock":
        print(AgentClient.lock() ? "Locked." : "Already locked.")

    case "status":
        if let expires = AgentClient.status() {
            print("Unlocked until \(expires.formatted(date: .omitted, time: .shortened)) (\(formatDuration(expires.timeIntervalSinceNow)) left).")
        } else {
            print("Locked.")
        }

    case "__agent":
        var ttl: TimeInterval = 3600
        if let i = args.firstIndex(of: "--ttl"), i + 1 < args.count { ttl = try parseDuration(args[i + 1]) }
        Agent.run(ttl: ttl)

    case "help", "-h", "--help":
        print(usage)

    default:
        throw SekError("unknown command '\(command)'\n\n\(usage)")
    }
}

do {
    try main()
} catch {
    FileHandle.standardError.write(Data("sek: \(error)\n".utf8))
    exit(1)
}
