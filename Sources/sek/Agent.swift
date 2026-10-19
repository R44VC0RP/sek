import AppKit
import Darwin
import Foundation

struct AgentRequest: Codable {
    var op: String
    var name: String?
}

struct AgentResponse: Codable {
    var ok: Bool
    var error: String?
    var value: String? // base64
    var expires: Double? // unix seconds
    var pid: Int32?
}

enum UnixSocket {
    static func address(_ path: String) throws -> sockaddr_un {
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else {
            throw SekError("socket path too long: \(path)")
        }
        withUnsafeMutableBytes(of: &addr.sun_path) { $0.copyBytes(from: bytes) }
        return addr
    }

    static func configure(_ fd: Int32, timeout: Int) {
        var on: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
        var tv = timeval(tv_sec: timeout, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    }

    static func connect(_ path: String) -> Int32? {
        guard var addr = try? address(path) else { return nil }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard rc == 0 else {
            close(fd)
            return nil
        }
        configure(fd, timeout: 10)
        return fd
    }

    static func readLine(_ fd: Int32, limit: Int = 1 << 20) -> Data? {
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while data.count < limit {
            let n = read(fd, &buffer, buffer.count)
            if n <= 0 { break }
            data.append(buffer, count: n)
            if let newline = data.firstIndex(of: 10) { return Data(data[..<newline]) }
        }
        return data.isEmpty ? nil : data
    }

    static func writeAll(_ fd: Int32, _ data: Data) -> Bool {
        data.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let n = write(fd, raw.baseAddress! + offset, raw.count - offset)
                if n <= 0 { return false }
                offset += n
            }
            return true
        }
    }

    static func send<T: Encodable>(_ fd: Int32, _ message: T) -> Bool {
        guard var payload = try? JSONEncoder().encode(message) else { return false }
        payload.append(10)
        return writeAll(fd, payload)
    }
}

enum AgentClient {
    /// Returns nil when no agent is running (or it went away mid-request).
    static func send(_ request: AgentRequest) -> AgentResponse? {
        guard let fd = UnixSocket.connect(Paths.socket.path) else { return nil }
        defer { close(fd) }
        guard UnixSocket.send(fd, request), let line = UnixSocket.readLine(fd) else { return nil }
        return try? JSONDecoder().decode(AgentResponse.self, from: line)
    }

    static func status() -> Date? {
        guard let response = send(AgentRequest(op: "status")), response.ok,
              let expires = response.expires
        else { return nil }
        return Date(timeIntervalSince1970: expires)
    }

    @discardableResult
    static func lock() -> Bool {
        guard let response = send(AgentRequest(op: "lock")) else { return false }
        // Wait for the old agent process to be gone, so it can't race a new one.
        if let pid = response.pid, pid > 0 {
            for _ in 0..<100 where kill(pid, 0) == 0 { usleep(50_000) }
        }
        return true
    }

    /// Spawns a detached agent, which shows the Touch ID prompt itself, and waits
    /// until it is serving.
    static func start(ttl: TimeInterval) throws -> Date {
        try Store.requireInitialized()
        lock()
        guard let exe = Bundle.main.executablePath else { throw SekError("cannot find own executable") }

        var actions: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&actions)
        defer { posix_spawn_file_actions_destroy(&actions) }
        posix_spawn_file_actions_addopen(&actions, 0, "/dev/null", O_RDONLY, 0)
        let logStart = (try? FileManager.default.attributesOfItem(atPath: Paths.agentLog.path)[.size] as? Int) ?? 0
        posix_spawn_file_actions_addopen(
            &actions, 1, Paths.agentLog.path, O_WRONLY | O_CREAT | O_APPEND, 0o600)
        posix_spawn_file_actions_adddup2(&actions, 1, 2)

        var attributes: posix_spawnattr_t?
        posix_spawnattr_init(&attributes)
        defer { posix_spawnattr_destroy(&attributes) }
        posix_spawnattr_setflags(&attributes, Int16(POSIX_SPAWN_SETSID))

        let args = [exe, "__agent", "--ttl", String(Int(ttl))]
        var argv: [UnsafeMutablePointer<CChar>?] = args.map { strdup($0) } + [nil]
        defer { argv.forEach { free($0) } }

        var pid: pid_t = 0
        let rc = posix_spawn(&pid, exe, &actions, &attributes, &argv, environ)
        guard rc == 0 else { throw SekError("could not start agent: \(String(cString: strerror(rc)))") }

        // The agent runs in its own session, so pass Ctrl-C on to it while waiting.
        var signalSources: [DispatchSourceSignal] = []
        for sig in [SIGINT, SIGTERM, SIGHUP] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .global())
            source.setEventHandler {
                kill(pid, SIGTERM)
                FileHandle.standardError.write(Data("\nsek: unlock cancelled\n".utf8))
                exit(130)
            }
            source.resume()
            signalSources.append(source)
        }
        defer { signalSources.forEach { $0.cancel() } }

        let deadline = Date().addingTimeInterval(120)
        while Date() < deadline {
            if let expires = status() { return expires }
            var exitStatus: Int32 = 0
            if waitpid(pid, &exitStatus, WNOHANG) == pid {
                let log = (try? Data(contentsOf: Paths.agentLog)) ?? Data()
                let appended = String(decoding: log.dropFirst(logStart), as: UTF8.self)
                let last = appended.split(separator: "\n").last.map(String.init) ?? "agent exited"
                throw SekError(last)
            }
            usleep(150_000)
        }
        kill(pid, SIGTERM)
        throw SekError("timed out waiting for authentication")
    }
}

enum Agent {
    private static func log(_ message: String) {
        let stamp = ISO8601DateFormatter().string(from: Date())
        FileHandle.standardError.write(Data("\(stamp) \(message)\n".utf8))
    }

    private static func peerPID(_ fd: Int32) -> pid_t {
        var pid: pid_t = 0
        var length = socklen_t(MemoryLayout<pid_t>.size)
        getsockopt(fd, SOL_LOCAL, LOCAL_PEERPID, &pid, &length)
        return pid
    }

    private static func processName(_ pid: pid_t) -> String {
        var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return "?" }
        return (String(cString: buffer) as NSString).lastPathComponent
    }

    private static func parentPID(_ pid: pid_t) -> pid_t {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return 0 }
        return pid_t(info.pbi_ppid)
    }

    /// "sek ← zsh (pid 12)": the client and whatever launched it.
    private static func describe(_ pid: pid_t) -> String {
        let parent = parentPID(pid)
        let base = "\(processName(pid)) (pid \(pid))"
        return parent > 0 ? "\(base) ← \(processName(parent)) (pid \(parent))" : base
    }

    static func run(ttl: TimeInterval) -> Never {
        signal(SIGPIPE, SIG_IGN)
        signal(SIGHUP, SIG_IGN)
        let path = Paths.socket.path

        // Only one agent at a time, so one can never unlink another's socket.
        // Taken before authenticating to avoid a pointless prompt.
        let lockFile = open(Paths.root.appendingPathComponent("agent.lock").path, O_RDWR | O_CREAT, 0o600)
        guard lockFile >= 0, flock(lockFile, LOCK_EX | LOCK_NB) == 0 else {
            log("another agent is already running; run `sek lock` first")
            exit(1)
        }

        let unlocker: Unlocker
        do {
            unlocker = try Unlocker(reason: "unlock your secrets for \(formatDuration(ttl))")
        } catch {
            log("unlock failed: \(error)")
            exit(1)
        }

        let expires = Date().addingTimeInterval(ttl)
        let shutdown: (String) -> Never = { reason in
            log("locked: \(reason)")
            unlink(path)
            exit(0)
        }

        umask(0o077)
        unlink(path)
        let server = socket(AF_UNIX, SOCK_STREAM, 0)
        guard server >= 0, var addr = try? UnixSocket.address(path) else {
            log("could not create socket")
            exit(1)
        }
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(server, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bound == 0, listen(server, 16) == 0 else {
            log("could not listen on \(path): \(String(cString: strerror(errno)))")
            exit(1)
        }
        chmod(path, 0o600)
        log("unlocked until \(ISO8601DateFormatter().string(from: expires)) (pid \(getpid()))")

        Thread {
            while true {
                let client = accept(server, nil, nil)
                if client < 0 {
                    if errno == EINTR || errno == ECONNABORTED { continue }
                    shutdown("accept failed: \(String(cString: strerror(errno)))")
                }
                handle(client, unlocker: unlocker, expires: expires, shutdown: shutdown)
            }
        }.start()

        DistributedNotificationCenter.default().addObserver(
            forName: Notification.Name("com.apple.screenIsLocked"), object: nil, queue: .main
        ) { _ in shutdown("screen locked") }
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.willSleepNotification, object: nil, queue: .main
        ) { _ in shutdown("going to sleep") }

        Timer.scheduledTimer(withTimeInterval: max(0, expires.timeIntervalSinceNow), repeats: false) { _ in
            shutdown("session expired")
        }

        var signalSources: [DispatchSourceSignal] = []
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { shutdown("signal \(sig)") }
            source.resume()
            signalSources.append(source)
        }

        withExtendedLifetime(signalSources) { RunLoop.main.run() }
        exit(0)
    }

    private static func handle(
        _ client: Int32, unlocker: Unlocker, expires: Date, shutdown: (String) -> Never
    ) {
        defer { close(client) }
        UnixSocket.configure(client, timeout: 5)

        // Only processes running as this user may talk to the agent.
        var uid: uid_t = 0
        var gid: gid_t = 0
        guard getpeereid(client, &uid, &gid) == 0, uid == getuid() else { return }

        // An expired agent answers nothing, so clients fall back to a direct prompt.
        if Date() >= expires { shutdown("session expired") }

        guard let line = UnixSocket.readLine(client),
              let request = try? JSONDecoder().decode(AgentRequest.self, from: line)
        else { return }

        switch request.op {
        case "status":
            _ = UnixSocket.send(
                client, AgentResponse(ok: true, expires: expires.timeIntervalSince1970, pid: getpid()))
        case "get":
            let name = request.name ?? ""
            let pid = peerPID(client)
            do {
                let value = try unlocker.open(name)
                log("get \(name) by \(describe(pid))")
                _ = UnixSocket.send(client, AgentResponse(ok: true, value: value.base64EncodedString()))
            } catch {
                log("get \(name) by \(describe(pid)) failed: \(error)")
                _ = UnixSocket.send(client, AgentResponse(ok: false, error: "\(error)"))
            }
        case "lock":
            _ = UnixSocket.send(client, AgentResponse(ok: true, pid: getpid()))
            shutdown("locked by user")
        default:
            _ = UnixSocket.send(client, AgentResponse(ok: false, error: "unknown op '\(request.op)'"))
        }
    }
}

func formatDuration(_ seconds: TimeInterval) -> String {
    let s = Int(seconds.rounded())
    if s >= 3600 {
        let m = (s % 3600) / 60
        return m == 0 ? "\(s / 3600)h" : "\(s / 3600)h \(m)m"
    }
    if s >= 60 { return "\(s / 60)m" }
    return "\(s)s"
}

func parseDuration(_ text: String) throws -> TimeInterval {
    let units: [Character: Double] = ["s": 1, "m": 60, "h": 3600, "d": 86400]
    var number = text
    var multiplier = 1.0
    if let last = text.last, let unit = units[last] {
        number = String(text.dropLast())
        multiplier = unit
    }
    guard let value = Double(number), value > 0 else { throw SekError("invalid duration '\(text)' (e.g. 30m, 2h)") }
    return value * multiplier
}
