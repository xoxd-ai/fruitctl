fruitctlFlake:
{ config, lib, pkgs, ... }:
let
  cfg = config.programs.fruitctl;
  isDarwin = pkgs.stdenv.hostPlatform.isDarwin;
  manifest = builtins.fromJSON (builtins.readFile "${fruitctlFlake}/integrations/agents.json");
  targetNames = builtins.attrNames cfg.targets;
  skillRoots = lib.unique (map (agent: manifest.agents.${agent}.skill.user) cfg.agents);
  nativePath = if cfg.nativePackage == null then null else "${cfg.nativePackage}/bin/claude-kvm-daemon";
  relayArgs = [ executable "relay" "--bridge" (if cfg.bridgeHost == null then "" else cfg.bridgeHost) "--socket" cfg.socketPath ]
    ++ lib.optionals (cfg.bridgeSocketPath != null) [ "--remote-socket" cfg.bridgeSocketPath ]
    ++ [ "--remote-command" cfg.bridgeCommand ];
  # D16/D36: a provider declaration names where a secret lives, never its value.
  # Only the fields of the chosen provider are written.
  publicSource = source: { inherit (source) provider; } // ({
    file = { inherit (source) path; } // lib.optionalAttrs source.allowSymlink { allowSymlink = true; };
    env = { inherit (source) name; };
    command = { inherit (source) argv; } // lib.optionalAttrs (source.timeoutMs != null) { inherit (source) timeoutMs; };
    keychain = { inherit (source) service account; } // lib.optionalAttrs (source.keychain != null) { inherit (source) keychain; };
  }.${source.provider});
  sourceValid = source: {
    file = absolute source.path;
    env = source.name != null && builtins.match "[A-Za-z_][A-Za-z0-9_]{0,127}" source.name != null;
    command = source.argv != null && source.argv != [ ] && absolute (builtins.head source.argv);
    keychain = source.service != null && source.service != "" && source.account != null && source.account != ""
      && (source.keychain == null || absolute source.keychain);
  }.${source.provider};
  publicTarget = _name: target: {
    # An unset capture deadline stays absent, never null.
    vnc = lib.filterAttrs (_: value: value != null) target.vnc;
  } // lib.optionalAttrs (target.credentialFile != null) {
    inherit (target) credentialFile;
  } // lib.optionalAttrs (target.credential != null) {
    credential = publicSource target.credential;
  } // lib.optionalAttrs (target.secrets != { }) {
    secrets = lib.mapAttrs (_: publicSource) target.secrets;
  } // lib.optionalAttrs (target.targetId != null) {
    inherit (target) targetId;
  } // lib.optionalAttrs (target.inputSource != null) {
    inherit (target) inputSource;
  } // lib.optionalAttrs target.input.pasteUnmappable {
    input.pasteUnmappable = true;
  } // lib.optionalAttrs (clipboardPolicy target != { }) {
    clipboard = clipboardPolicy target;
  } // lib.optionalAttrs (wakePolicy target != { }) {
    wake = wakePolicy target;
  } // lib.optionalAttrs (desktopStatePolicy target != { }) {
    desktopState = desktopStatePolicy target;
  } // lib.optionalAttrs (target.daemonPath != null || nativePath != null) {
    daemonPath = if target.daemonPath != null then target.daemonPath else nativePath;
  } // lib.optionalAttrs (target.hostHelper != null) {
    # Unset display identities and mapping fields stay absent, never null.
    hostHelper = lib.filterAttrs (_: value: value != null) {
      inherit (target.hostHelper) sshHost command displayId displayUuid;
    } // lib.optionalAttrs (target.hostHelper.mapping != null) {
      mapping = lib.filterAttrs (_: value: value != null) target.hostHelper.mapping;
    };
  };
  # Only non-default clipboard fields reach the broker profile.
  clipboardPolicy = target: lib.filterAttrs (_: value: value != null) {
    read = if target.clipboard.read then true else null;
    extended = if target.clipboard.extended then null else false;
    inherit (target.clipboard) maxBytes ttlMs;
  };
  # Broker defaults: no wake hold; a sentinel on the first usable destination
  # (desktopState.ssh, wake.ssh, hostHelper.sshHost). Only non-defaults render.
  wakePolicy = target: lib.optionalAttrs (target.wake.ssh != null) ({
    inherit (target.wake) ssh;
  } // lib.optionalAttrs (!target.wake.enabled) { enabled = false; });
  desktopStatePolicy = target: lib.filterAttrs (_: value: value != null) {
    inherit (target.desktopState) ssh;
    enabled = if target.desktopState.enabled then null else false;
  };
  brokerConfig = {
    schema = "fruitctl.config.v1";
    targets = lib.mapAttrs publicTarget cfg.targets;
  };
  executable = "${cfg.package}/bin/fruitctl";
  serverEntry = target: {
    command = executable;
    args = [ "mcp" "--target" target "--socket" cfg.socketPath ];
  };
  serverEntries = builtins.listToAttrs (map (target: lib.nameValuePair "fruitctl-${target}" (serverEntry target)) targetNames);
  fragment = agent: target:
    let
      entry = serverEntry target;
      serverName = "fruitctl-${target}";
      definition = manifest.agents.${agent};
      jsonEntry = entry
        // lib.optionalAttrs (builtins.elem agent [ "claude" "vscode" ]) { type = "stdio"; };
      document = if agent == "opencode" then {
        mcp.${serverName} = { type = "local"; command = [ executable ] ++ entry.args; enabled = true; };
      } else { mcpServers.${serverName} = jsonEntry; };
    in if definition.config.format == "toml" then ''
      [mcp_servers.${builtins.toJSON serverName}]
      command = ${builtins.toJSON executable}
      args = ${builtins.toJSON entry.args}
    '' else builtins.toJSON document + "\n";
  fragments = builtins.listToAttrs (lib.concatMap (agent:
    map (target: lib.nameValuePair
      "fruitctl/agents/${agent}/${target}.${if manifest.agents.${agent}.config.format == "toml" then "toml" else "json"}"
      { text = fragment agent target; }) targetNames) cfg.agents);
  secretSource = lib.types.submodule {
    options = {
      provider = lib.mkOption {
        type = lib.types.enum [ "file" "env" "command" "keychain" ];
        description = "Where the broker reads this secret when it is needed: an exact file (for example a sops-nix materialized path), a named environment variable (discouraged), an explicit command whose stdout is the secret, or a Darwin login-keychain item.";
      };
      path = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "file: absolute path, as a string (never a Nix path or readFile). The file must be owned by the broker user with no group/other access, in a directory nobody else can write.";
      };
      allowSymlink = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "file: follow the path when it is itself a symlink. The resolved file passes the same owner, mode and parent checks. sops-nix default paths need no symlink allowance; a custom sops-nix `path` does.";
      };
      name = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "env: variable name in the broker's environment. Discouraged; `fruitctl doctor --secrets` warns env_provider_discouraged. The broker removes it from every child environment.";
      };
      argv = lib.mkOption {
        type = lib.types.nullOr (lib.types.listOf lib.types.str);
        default = null;
        example = lib.literalExpression ''[ "''${pkgs.vault}/bin/vault" "kv" "get" "-field=password" "secret/desktop" ]'';
        description = "command: absolute executable and literal arguments, run without a shell. stdout (one trailing newline removed) is the secret; stderr is discarded unread.";
      };
      timeoutMs = lib.mkOption {
        type = lib.types.nullOr (lib.types.ints.between 100 10000);
        default = null;
        description = "command: kill the command after this many milliseconds (default 5000).";
      };
      service = lib.mkOption { type = lib.types.nullOr lib.types.str; default = null; description = "keychain: generic-password service (security -s)."; };
      account = lib.mkOption { type = lib.types.nullOr lib.types.str; default = null; description = "keychain: generic-password account (security -a)."; };
      keychain = lib.mkOption { type = lib.types.nullOr lib.types.str; default = null; description = "keychain: optional absolute keychain file; default is the search list."; };
    };
  };
  profileModule = { ... }: {
    options = {
      targetId = lib.mkOption {
        type = lib.types.nullOr (lib.types.strMatching "[A-Za-z0-9][A-Za-z0-9._-]{0,127}");
        default = null;
        description = "Optional stable physical-desktop identity on the Darwin broker. Use one profile per desktop; duplicate identities are refused.";
      };
      vnc = {
        host = lib.mkOption { type = lib.types.str; default = "127.0.0.1"; description = "Seat-side VNC address, usually an SSH tunnel loopback endpoint."; };
        port = lib.mkOption { type = lib.types.port; default = 15900; description = "Seat-side VNC port; distinct from a local Screen Sharing listener."; };
        username = lib.mkOption { type = lib.types.str; default = ""; description = "Target account name. No password is stored in configuration."; };
        captureTimeoutMs = lib.mkOption {
          type = lib.types.nullOr (lib.types.ints.between 1000 20000);
          default = null;
          example = 10000;
          description = "Optional fresh full-capture deadline in milliseconds, passed to the native controller as --capture-timeout-ms. Unset keeps the controller default: 10000 on Apple Screen Sharing, otherwise 5000. A capture that misses it still fails as stale_screen; no cached frame is returned.";
        };
      };
      inputSource = lib.mkOption {
        type = lib.types.nullOr (lib.types.strMatching "[A-Za-z0-9][A-Za-z0-9._ ()/+-]{0,127}");
        default = null;
        example = "com.apple.keylayout.US";
        description = "Optional declared target input source, as a HIToolbox source ID or layout name. `fruitctl doctor --macos` warns input_source_mismatch when the target's selected source differs.";
      };
      input.pasteUnmappable = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "D29 paste routing: key_type pastes text the target's keymap cannot type (save the clipboard, set the text, Cmd+V, restore it) and journals it as a paste. Never used for type_secret. With a declared non-US inputSource every printable character is pasted; without this option such a target refuses key_type as input_source_not_us.";
      };
      clipboard = {
        read = lib.mkOption {
          type = lib.types.bool;
          default = false;
          description = "Allow clipboard_read (D8). Off by default. Text containing a declared secret, such as the VNC credential, is withheld.";
        };
        maxBytes = lib.mkOption {
          type = lib.types.nullOr (lib.types.ints.between 1 1048576);
          default = null;
          description = "Longest clipboard_read text returned, in UTF-8 bytes; longer text is truncated. Unset keeps 16384.";
        };
        ttlMs = lib.mkOption {
          type = lib.types.nullOr (lib.types.ints.between 1000 86400000);
          default = null;
          description = "clipboard_read refuses text older than this. Requires clipboard.read.";
        };
        extended = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Advertise ExtendedClipboard for UTF-8 clipboard text. False keeps legacy Latin-1 cut text only.";
        };
      };
      credentialFile = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Absolute runtime credential file on the Darwin controller. Use a string, never a Nix path or readFile of its contents. Backward-compatible alias for credential = { provider = \"file\"; path = ...; allowSymlink = true; }.";
      };
      credential = lib.mkOption {
        type = lib.types.nullOr secretSource;
        default = null;
        description = "The target's VNC/ARD credential provider on the Darwin controller. Set this or credentialFile, not both.";
      };
      secrets = lib.mkOption {
        type = lib.types.attrsOf secretSource;
        default = { };
        example = lib.literalExpression ''{ login-password = { provider = "file"; path = config.sops.secrets."fruitctl/desktop-login".path; }; }'';
        description = "D16 type_secret allowlist for this target: ref name to provider. An agent can type only these refs, by name; values are resolved on the Darwin broker and never returned, logged or journalled.";
      };
      daemonPath = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Absolute signed native-client path; overrides nativePackage for this target.";
      };
      wake = {
        ssh = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          example = "alex@office-desktop";
          description = "Opt-in display wake hold: while a client owns the lease, the broker runs `caffeinate -d -u` on the target over this SSH destination (user@host or an existing alias). Unset means no hold. Advisory; failures are reported in health and never fail input.";
        };
        enabled = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "False turns the wake hold off while keeping wake.ssh, which the desktop-state sentinel still uses as its fallback destination.";
        };
      };
      desktopState = {
        enabled = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Desktop-state sentinel: before input, read lock, display sleep and consent-dialog state over SSH and refuse input that macOS would block. On by default whenever a destination is known; false disables it.";
        };
        ssh = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          example = "alex@office-desktop";
          description = "Sentinel SSH destination, ideally the console user. Unset falls back to wake.ssh, then hostHelper.sshHost; with none of them the sentinel reports not_configured and refuses nothing.";
        };
      };
      hostHelper = lib.mkOption {
        default = null;
        type = lib.types.nullOr (lib.types.submodule {
          options = {
            sshHost = lib.mkOption { type = lib.types.str; description = "Existing SSH host alias for the separately installed capture/indicator helper."; };
            command = lib.mkOption { type = lib.types.listOf lib.types.str; description = "[ \"/absolute/path/FruitctlHost\" \"--stdio\" ]: the Host executable and its stdio flag, exactly as the broker accepts it; no shell expression."; };
            displayId = lib.mkOption { type = lib.types.nullOr lib.types.ints.unsigned; default = null; description = "Qualified target display identifier. Set this, displayUuid, or both."; };
            displayUuid = lib.mkOption { type = lib.types.nullOr lib.types.str; default = null; description = "CoreGraphics display UUID (FruitctlHost --doctor lists them). Survives display-ID changes; the Host must run with the same --display-uuid."; };
            mapping = lib.mkOption {
              default = null;
              description = "Qualified capture-to-native input mapping. Without it the helper permits observations only.";
              type = lib.types.nullOr (lib.types.submodule {
                options = {
                  qualificationReceipt = lib.mkOption { type = lib.types.str; description = "Durable qualification receipt identifying this measured mapping."; };
                  displayId = lib.mkOption { type = lib.types.nullOr lib.types.ints.positive; default = null; description = "Display identifier matching hostHelper.displayId (null when that is unset)."; };
                  displayUuid = lib.mkOption { type = lib.types.nullOr lib.types.str; default = null; description = "Display UUID matching hostHelper.displayUuid (null when that is unset)."; };
                  scale = lib.mkOption { type = lib.types.nullOr lib.types.number; default = null; description = "Qualified HiDPI scale (pixels per point). When set, a capture at another scale refuses input."; };
                  nativeWidth = lib.mkOption { type = lib.types.ints.positive; description = "Qualified native framebuffer width in pixels."; };
                  nativeHeight = lib.mkOption { type = lib.types.ints.positive; description = "Qualified native framebuffer height in pixels."; };
                  scaledWidth = lib.mkOption { type = lib.types.ints.positive; description = "Qualified observation width in pixels."; };
                  scaledHeight = lib.mkOption { type = lib.types.ints.positive; description = "Qualified observation height in pixels."; };
                  displayBounds = {
                    x = lib.mkOption { type = lib.types.number; description = "Measured display origin x in points."; };
                    y = lib.mkOption { type = lib.types.number; description = "Measured display origin y in points."; };
                    width = lib.mkOption { type = lib.types.number; description = "Measured positive display width in points."; };
                    height = lib.mkOption { type = lib.types.number; description = "Measured positive display height in points."; };
                  };
                };
              });
            };
          };
        });
        description = "Optional independently qualified target capture/indicator app; no helper is installed by this module.";
      };
    };
  };
  # Same character set as the broker's wake, sentinel, helper and doctor SSH validators.
  sshDestination = value: value == null || builtins.match "[a-zA-Z0-9_][]a-zA-Z0-9_.@:[-]{0,255}" value != null;
  absolute = value: value != null && lib.hasPrefix "/" value && !(lib.hasInfix "\n" value);
  displayUuid = value: builtins.match "[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}" value != null;
  sameUuid = left: right: if left == null || right == null then left == right else lib.toUpper left == lib.toUpper right;
in {
  options.programs.fruitctl = {
    enable = lib.mkEnableOption "Fruitctl runtime, shared session service and agent skills";
    installOnly = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Install the CLI and canonical agent skills without target configuration, MCP entries, socket directories or services.";
    };
    package = lib.mkOption {
      type = lib.types.package;
      default = fruitctlFlake.packages.${pkgs.stdenv.hostPlatform.system}.fruitctl;
      description = "Immutable upstream Node runtime. Linux uses an SSH Darwin bridge.";
    };
    nativePackage = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = null;
      description = "An explicitly selected signed native release on Darwin. installOnly stages it without starting a broker. There is no implicit legacy fallback.";
    };
    targets = lib.mkOption {
      type = lib.types.attrsOf (lib.types.submodule profileModule);
      default = { };
      description = "Operator-declared target profiles. Linux declares names only; VNC credentials and configuration live on its Darwin bridge.";
    };
    bridgeHost = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Existing SSH alias of the Darwin controller; required on Linux. Never supply a credential here.";
    };
    bridgeSocketPath = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Remote Darwin broker socket, if non-default. Null uses the remote user's default; it is distinct from the local Linux socket.";
    };
    bridgeCommand = lib.mkOption {
      type = lib.types.str;
      default = "fruitctl";
      description = "Remote Fruitctl executable; an absolute immutable path avoids non-interactive SSH PATH differences.";
    };
    socketPath = lib.mkOption {
      type = lib.types.str;
      default = if isDarwin
        then "${config.home.homeDirectory}/Library/Application Support/fruitctl/run/broker.sock"
        else "${config.xdg.stateHome}/fruitctl/relay.sock";
      description = "Private shared broker/relay socket on this seat. bridgeSocketPath selects a separate remote socket.";
    };
    enableService = lib.mkOption {
      type = lib.types.bool;
      default = !cfg.installOnly;
      description = "Run one shared broker on Darwin, or one SSH relay on Linux. Must be false in installOnly mode.";
    };
    agents = lib.mkOption {
      type = lib.types.listOf (lib.types.enum (builtins.attrNames manifest.agents));
      default = [ "claude" "codex" "pi" "junie" ];
      description = "Agent skill projections and MCP configuration fragments. Existing mutable agent configuration is never overwritten.";
    };
    mcpServers = lib.mkOption {
      type = lib.types.attrsOf lib.types.attrs;
      readOnly = true;
      description = "Declarative MCP entries for the owning harness module to merge. Entries contain no credential values.";
    };
    configPath = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      readOnly = true;
      description = "Controller configuration path; null when disabled or installOnly. Linux does not get a credential-bearing target document.";
    };
  };

  config = lib.mkMerge [
    {
      programs.fruitctl.mcpServers = if cfg.enable && !cfg.installOnly then serverEntries else { };
      programs.fruitctl.configPath = if !cfg.enable || cfg.installOnly then null
        else if isDarwin
        then "${config.home.homeDirectory}/Library/Application Support/fruitctl/config.json"
        else "${config.xdg.configHome}/fruitctl/config.json";
    }
    (lib.mkIf cfg.enable {
      assertions = [
        { assertion = !cfg.installOnly || !cfg.enableService; message = "Fruitctl installOnly cannot enable a broker or relay service."; }
        { assertion = !cfg.installOnly || targetNames == [ ]; message = "Fruitctl installOnly requires no targets; use controller mode for target profiles."; }
        { assertion = !cfg.installOnly || (cfg.bridgeHost == null && cfg.bridgeSocketPath == null && cfg.bridgeCommand == "fruitctl"); message = "Fruitctl installOnly cannot configure an SSH bridge."; }
        { assertion = isDarwin || cfg.nativePackage == null; message = "Fruitctl nativePackage is Darwin-only; Linux uses the portable CLI and SSH relay."; }
        { assertion = cfg.nativePackage == null || lib.meta.availableOn pkgs.stdenv.hostPlatform cfg.nativePackage; message = "Fruitctl nativePackage must support this controller's Darwin architecture."; }
      ];
      home.packages = [ cfg.package ] ++ lib.optional (isDarwin && cfg.nativePackage != null) cfg.nativePackage;
      home.file = builtins.listToAttrs (map (root: lib.nameValuePair root {
        source = "${cfg.package}/share/fruitctl/skills/fruitctl";
        recursive = true;
      }) skillRoots);
    })
    (lib.mkIf (cfg.enable && !cfg.installOnly) {
      assertions = [
        { assertion = targetNames != [ ]; message = "programs.fruitctl.targets must declare at least one profile."; }
        { assertion = builtins.all (name: builtins.match "[A-Za-z0-9][A-Za-z0-9._-]{0,127}" name != null) targetNames; message = "Fruitctl target names must be profile identifiers, not host expressions."; }
        { assertion = absolute cfg.socketPath && builtins.stringLength cfg.socketPath < 104; message = "Fruitctl socketPath must be absolute and shorter than the Darwin Unix-socket path limit (104 bytes)."; }
        { assertion = lib.hasPrefix "${config.home.homeDirectory}/" (builtins.dirOf cfg.socketPath); message = "Fruitctl's managed socket directory must be a dedicated subdirectory of this user's home."; }
        { assertion = cfg.bridgeSocketPath == null || absolute cfg.bridgeSocketPath; message = "Fruitctl bridgeSocketPath must be an absolute remote path when supplied."; }
        { assertion = cfg.bridgeCommand == "fruitctl" || absolute cfg.bridgeCommand; message = "Fruitctl bridgeCommand must be fruitctl or an absolute executable path."; }
        { assertion = isDarwin || (cfg.bridgeHost != null && cfg.bridgeHost != "" && !(lib.hasPrefix "-" cfg.bridgeHost) && !(lib.hasInfix "\n" cfg.bridgeHost)); message = "Linux Fruitctl requires an existing Darwin bridgeHost SSH alias."; }
        { assertion = isDarwin || (cfg.nativePackage == null && builtins.all (name: cfg.targets.${name}.targetId == null && cfg.targets.${name}.inputSource == null && !cfg.targets.${name}.input.pasteUnmappable && clipboardPolicy cfg.targets.${name} == { } && cfg.targets.${name}.credentialFile == null && cfg.targets.${name}.credential == null && cfg.targets.${name}.secrets == { } && cfg.targets.${name}.daemonPath == null && cfg.targets.${name}.hostHelper == null && cfg.targets.${name}.vnc.username == "" && cfg.targets.${name}.vnc.host == "127.0.0.1" && cfg.targets.${name}.vnc.port == 15900 && cfg.targets.${name}.vnc.captureTimeoutMs == null && wakePolicy cfg.targets.${name} == { } && desktopStatePolicy cfg.targets.${name} == { }) targetNames); message = "Linux declares Fruitctl target names only; configure physical identities, VNC, credentials and native clients on the Darwin bridge."; }
        { assertion = !isDarwin || builtins.all (name: let target = cfg.targets.${name}; in
            (if target.credential != null then target.credentialFile == null && sourceValid target.credential else absolute target.credentialFile)
            && absolute (if target.daemonPath != null then target.daemonPath else nativePath)) targetNames;
          message = "Each Darwin Fruitctl target requires exactly one VNC credential provider (credential, or an absolute credentialFile) and a qualified daemonPath or nativePackage."; }
        { assertion = builtins.all (name: builtins.all (ref: builtins.match "[A-Za-z0-9][A-Za-z0-9_.-]{0,63}" ref != null && sourceValid cfg.targets.${name}.secrets.${ref})
            (builtins.attrNames cfg.targets.${name}.secrets)) targetNames;
          message = "Fruitctl secrets need ref names of letters, digits, '.', '_' or '-' and a complete provider: file.path absolute, env.name a variable name, command.argv with an absolute executable, or keychain.service and account."; }
        { assertion = builtins.all (name: let helper = cfg.targets.${name}.hostHelper; in helper == null || (builtins.match "[a-zA-Z0-9][]a-zA-Z0-9_.@:[-]{0,255}" helper.sshHost != null && builtins.length helper.command == 2 && absolute (builtins.head helper.command) && lib.hasSuffix "/FruitctlHost" (builtins.head helper.command) && builtins.elemAt helper.command 1 == "--stdio" && (helper.displayId != null || helper.displayUuid != null) && (helper.displayId == null || helper.displayId > 0) && (helper.displayUuid == null || displayUuid helper.displayUuid))) targetNames; message = "Fruitctl hostHelper requires an SSH alias, [ /absolute/path/FruitctlHost --stdio ] command and a positive displayId or a displayUuid."; }
        { assertion = builtins.all (name: cfg.targets.${name}.clipboard.ttlMs == null || cfg.targets.${name}.clipboard.read) targetNames; message = "Fruitctl clipboard.ttlMs requires clipboard.read."; }
        { assertion = builtins.all (name: sshDestination cfg.targets.${name}.wake.ssh && sshDestination cfg.targets.${name}.desktopState.ssh) targetNames; message = "Fruitctl wake.ssh and desktopState.ssh must be explicit user@host destinations or SSH aliases, not options or shell text."; }
        { assertion = builtins.all (name: let helper = cfg.targets.${name}.hostHelper; mapping = if helper == null then null else helper.mapping; in mapping == null || (mapping.qualificationReceipt != "" && mapping.displayId == helper.displayId && sameUuid mapping.displayUuid helper.displayUuid && (mapping.scale == null || (mapping.scale >= 1 && mapping.scale <= 8)) && mapping.displayBounds.width > 0 && mapping.displayBounds.height > 0)) targetNames; message = "Fruitctl hostHelper mapping requires its qualification receipt, matching displayId/displayUuid, a scale within 1-8 when set, and positive display bounds."; }
      ];
      home.file = lib.optionalAttrs isDarwin {
        "Library/Application Support/fruitctl/config.json".text = builtins.toJSON brokerConfig + "\n";
      };
      xdg.configFile = fragments;
      home.activation.fruitctlSocketDirectory = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        $DRY_RUN_CMD mkdir -p ${lib.escapeShellArg (builtins.dirOf cfg.socketPath)}
        $DRY_RUN_CMD chmod 0700 ${lib.escapeShellArg (builtins.dirOf cfg.socketPath)}
      '';
      launchd.agents.fruitctl-broker = lib.mkIf (isDarwin && cfg.enableService) {
        enable = true;
        config = {
          Label = "ai.xoxd.fruitctl.broker";
          ProgramArguments = [ executable "broker" "--socket" cfg.socketPath "--config" cfg.configPath ];
          ProcessType = "Interactive";
          RunAtLoad = true;
          # Cleanup quarantine is process-local in the preview. A fresh broker
          # must not automatically clear it after an unconfirmed input release.
          KeepAlive = false;
        };
      };
      # Linux shells and doctor find the managed relay and its bridge without
      # repeating flags. None of these values is a credential.
      home.sessionVariables = lib.mkIf (!isDarwin) ({
        FRUITCTL_SOCKET_PATH = cfg.socketPath;
        FRUITCTL_BRIDGE_HOST = cfg.bridgeHost;
      } // lib.optionalAttrs (cfg.bridgeCommand != "fruitctl") {
        FRUITCTL_BRIDGE_COMMAND = cfg.bridgeCommand;
      });
      systemd.user.services.fruitctl-relay = lib.mkIf (!isDarwin && cfg.enableService) {
        Unit = {
          Description = "Fruitctl SSH bridge to the Darwin desktop broker";
          # The relay reconnects its bridge itself with capped backoff. systemd
          # restarts only a crashed relay, and stops trying after five starts
          # in five minutes.
          StartLimitIntervalSec = 300;
          StartLimitBurst = 5;
        };
        Service = {
          ExecStart = lib.escapeShellArgs relayArgs;
          Restart = "on-failure";
          RestartSec = "5s";
          # 3: owned SSH retirement unconfirmed; reconcile the target first.
          # 78: configuration error that a restart cannot repair.
          RestartPreventExitStatus = "3 78";
          # Stopping or restarting reaps the whole unit, so no SSH child of a
          # former relay outlives it.
          KillMode = "control-group";
          TimeoutStopSec = "5s";
          UMask = "0077";
        };
        Install.WantedBy = [ "default.target" ];
      };
    })
  ];
}
