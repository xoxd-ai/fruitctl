{ pkgs, homeManagerSource, fruitctlFlake }:
let
  evaluate = system: settings:
    let
      targetPkgs = packageSets.${system};
      hm = import "${homeManagerSource}/modules" {
        pkgs = targetPkgs;
        configuration = {
          imports = [ fruitctlFlake.homeManagerModules.default ];
          home.username = "fruitctl-test";
          home.homeDirectory = if targetPkgs.stdenv.hostPlatform.isDarwin then "/Users/fruitctl-test" else "/home/fruitctl-test";
          home.stateVersion = "25.05";
          programs.fruitctl = settings;
        };
      };
    in hm.config;
  linux = evaluate "x86_64-linux" {
    enable = true;
    bridgeHost = "darwin-bridge";
    bridgeSocketPath = "/Users/bridge/custom-fruitctl/broker.sock";
    targets.desktop = { };
    targets."second.desktop" = { };
  };
  linuxWithoutService = evaluate "x86_64-linux" {
    enable = true;
    enableService = false;
    bridgeHost = "darwin-bridge";
    targets.desktop = { };
  };
  darwin = evaluate "aarch64-darwin" {
    enable = true;
    targets.desktop = {
      targetId = "fixture-desktop";
      inputSource = "com.apple.keylayout.US";
      credentialFile = "/Users/fruitctl-test/.config/private/desktop-password";
      daemonPath = "/Users/fruitctl-test/Applications/qualified-native/claude-kvm-daemon";
      vnc.username = "fixture-user";
      vnc.captureTimeoutMs = 12000;
      input.pasteUnmappable = true;
      clipboard.read = true;
      clipboard.ttlMs = 60000;
      wake.ssh = "fixture-user@fixture-target";
    };
  };
  # Wake kept but off; sentinel off with its own destination.
  sentinelOff = evaluate "aarch64-darwin" {
    enable = true;
    targets.desktop = {
      credentialFile = "/Users/fruitctl-test/private/password";
      daemonPath = "/Users/fruitctl-test/Applications/qualified-native/claude-kvm-daemon";
      wake = { ssh = "fixture-user@fixture-target"; enabled = false; };
      desktopState = { ssh = "console-user@fixture-target"; enabled = false; };
    };
  };
  sentinelOffDocument = (builtins.fromJSON sentinelOff.home.file."Library/Application Support/fruitctl/config.json".text).targets.desktop;
  attachmentRejected = builtins.all (extra: rejected "aarch64-darwin" {
    enable = true;
    targets.desktop = {
      credentialFile = "/Users/fruitctl-test/private/password";
      daemonPath = "/Users/fruitctl-test/Applications/qualified-native/claude-kvm-daemon";
    } // extra;
  }) [ { wake.ssh = "-oProxyCommand=touch"; } { desktopState.ssh = "user@host; reboot"; } ]
  && builtins.all (extra: rejected "x86_64-linux" { enable = true; bridgeHost = "darwin-bridge"; targets.desktop = extra; })
    [ { wake.ssh = "fixture-user@fixture-target"; } { desktopState.enabled = false; } ];
  nativeController = fruitctlFlake.packages.aarch64-darwin.native-controller;
  nativeDarwin = evaluate "aarch64-darwin" {
    enable = true;
    enableService = false;
    nativePackage = nativeController;
    targets.desktop.credentialFile = "/Users/fruitctl-test/.config/private/desktop-password";
  };
  disabledDarwin = evaluate "aarch64-darwin" { };
  systems = [ "aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
  packageSets = pkgs.lib.genAttrs systems (system:
    import fruitctlFlake.inputs.nixpkgs { inherit system; });
  installations = pkgs.lib.genAttrs systems (system: evaluate system {
    enable = true;
    installOnly = true;
  });
  nativeInstallation = evaluate "aarch64-darwin" {
    enable = true;
    installOnly = true;
    nativePackage = nativeController;
  };
  installedSkills = configuration: builtins.filter
    (path: pkgs.lib.hasSuffix "skills/fruitctl" path)
    (builtins.attrNames configuration.home.file);
  installationHasNoConnection = configuration:
    configuration.programs.fruitctl.configPath == null
    && configuration.programs.fruitctl.mcpServers == { }
    && configuration.programs.fruitctl.targets == { }
    && !configuration.programs.fruitctl.enableService
    && !(configuration.home.file ? "Library/Application Support/fruitctl/config.json")
    && !(builtins.any (path: pkgs.lib.hasPrefix "fruitctl/" path)
      (builtins.attrNames configuration.xdg.configFile))
    && !(configuration.home.activation ? fruitctlSocketDirectory)
    && !(configuration.launchd.agents ? fruitctl-broker)
    && !(configuration.systemd.user.services ? fruitctl-relay);
  rejected = system: settings:
    !(builtins.tryEval (evaluate system settings).programs.fruitctl.mcpServers).success;
  installServiceRejected = builtins.all (system: rejected system {
    enable = true;
    installOnly = true;
    enableService = true;
  }) [ "aarch64-darwin" "x86_64-linux" ];
  installTargetsRejected = rejected "aarch64-darwin" {
    enable = true;
    installOnly = true;
    targets.desktop = {
      credentialFile = "/Users/fruitctl-test/private/password";
      daemonPath = "/Users/fruitctl-test/Applications/qualified-native/claude-kvm-daemon";
    };
  };
  installBridgeRejected = builtins.all (bridge: rejected "x86_64-linux" ({
    enable = true;
    installOnly = true;
  } // bridge)) [
    { bridgeHost = "darwin-bridge"; }
    { bridgeSocketPath = "/Users/bridge/custom/broker.sock"; }
    { bridgeCommand = "/nix/store/example/bin/fruitctl"; }
  ];
  installLinuxNativeRejected = rejected "x86_64-linux" {
    enable = true;
    installOnly = true;
    nativePackage = nativeController;
  };
  installWrongDarwinNativeRejected = rejected "x86_64-darwin" {
    enable = true;
    installOnly = true;
    nativePackage = nativeController;
  };
  installInvalidNativeRejected = !(builtins.tryEval (evaluate "aarch64-darwin" {
    enable = true;
    installOnly = true;
    nativePackage = false;
  }).programs.fruitctl.nativePackage).success;
  # Only this evaluator fixture discards dependency context before JSON parsing.
  nativeDocument = builtins.fromJSON (builtins.unsafeDiscardStringContext
    nativeDarwin.home.file."Library/Application Support/fruitctl/config.json".text);
  helperDarwin = evaluate "aarch64-darwin" {
    enable = true;
    targets.desktop = {
      credentialFile = "/Users/fruitctl-test/.config/private/desktop-password";
      daemonPath = "/Users/fruitctl-test/Applications/qualified-native/claude-kvm-daemon";
      hostHelper = {
        sshHost = "fixture-target";
        command = [ "/Users/fixture/Applications/FruitctlHost.app/Contents/MacOS/FruitctlHost" "--stdio" ];
        displayId = 7;
        mapping = {
          qualificationReceipt = "fixture/owned-capture-mapping.json";
          displayId = 7;
          nativeWidth = 3840;
          nativeHeight = 2160;
          scaledWidth = 1920;
          scaledHeight = 1080;
          displayBounds = { x = -1920; y = 0; width = 1920; height = 1080; };
        };
      };
    };
  };
  helperDocument = builtins.fromJSON helperDarwin.home.file."Library/Application Support/fruitctl/config.json".text;
  uuidHelper = mapping: {
    enable = true;
    targets.desktop = {
      credentialFile = "/Users/fruitctl-test/.config/private/desktop-password";
      daemonPath = "/Users/fruitctl-test/Applications/qualified-native/claude-kvm-daemon";
      hostHelper = {
        sshHost = "fixture-target";
        command = [ "/Users/fixture/Applications/FruitctlHost.app/Contents/MacOS/FruitctlHost" "--stdio" ];
        displayUuid = "37d8832a-2d66-02ca-b9f7-8f30a301b230";
        inherit mapping;
      };
    };
  };
  uuidMapping = {
    qualificationReceipt = "fixture/owned-capture-mapping.json";
    displayUuid = "37D8832A-2D66-02CA-B9F7-8F30A301B230";
    scale = 2;
    nativeWidth = 3024;
    nativeHeight = 1964;
    scaledWidth = 1512;
    scaledHeight = 982;
    displayBounds = { x = 0; y = 0; width = 1512; height = 982; };
  };
  uuidDocument = builtins.fromJSON (evaluate "aarch64-darwin" (uuidHelper uuidMapping)).home.file."Library/Application Support/fruitctl/config.json".text;
  uuidRejected = rejected "aarch64-darwin" (uuidHelper (uuidMapping // { displayUuid = "00000000-0000-4000-8000-000000000000"; }))
    && rejected "aarch64-darwin" (uuidHelper (uuidMapping // { scale = 0.5; }))
    && rejected "aarch64-darwin" (uuidHelper (uuidMapping // { displayId = 7; }))
    && rejected "aarch64-darwin" (pkgs.lib.recursiveUpdate (uuidHelper null) { targets.desktop.hostHelper.displayUuid = "not-a-uuid"; })
    && rejected "aarch64-darwin" (pkgs.lib.recursiveUpdate (uuidHelper null) { targets.desktop.hostHelper.displayUuid = null; })
    # The broker accepts only the FruitctlHost executable and an alias-shaped sshHost.
    && rejected "aarch64-darwin" (pkgs.lib.recursiveUpdate (uuidHelper null) { targets.desktop.hostHelper.command = [ "/usr/bin/ssh" "--stdio" ]; })
    && rejected "aarch64-darwin" (pkgs.lib.recursiveUpdate (uuidHelper null) { targets.desktop.hostHelper.command = [ "/Applications/Fruitctl\tHost/FruitctlHost" "--stdio" ]; })
    && rejected "aarch64-darwin" (pkgs.lib.recursiveUpdate (uuidHelper null) { targets.desktop.hostHelper.sshHost = "-oProxyCommand=x"; });
  linuxRelay = linux.systemd.user.services.fruitctl-relay.Service;
  darwinBroker = darwin.launchd.agents.fruitctl-broker.config;
  linuxFiles = linux.xdg.configFile;
  # Drop derivation context only in the evaluator fixture to inspect JSON keys.
  # The installed fragments retain their immutable runtime dependencies.
  desktopFragment = builtins.fromJSON (builtins.unsafeDiscardStringContext linuxFiles."fruitctl/agents/claude/desktop.json".text);
  secondFragment = builtins.fromJSON (builtins.unsafeDiscardStringContext linuxFiles."fruitctl/agents/claude/second.desktop.json".text);
  darwinDocument = builtins.fromJSON darwin.home.file."Library/Application Support/fruitctl/config.json".text;
  credentialRejected = !(builtins.tryEval (evaluate "x86_64-linux" {
    enable = true;
    bridgeHost = "darwin-bridge";
    targets.desktop.credentialFile = "/home/fruitctl-test/private/password";
  }).programs.fruitctl.mcpServers).success;
  missingBridgeRejected = !(builtins.tryEval (evaluate "x86_64-linux" {
    enable = true;
    targets.desktop = { };
  }).programs.fruitctl.mcpServers).success;
  noProfilesRejected = !(builtins.tryEval (evaluate "aarch64-darwin" {
    enable = true;
  }).programs.fruitctl.mcpServers).success;
  invalidCaptureTimeoutRejected = !(builtins.tryEval (evaluate "aarch64-darwin" {
    enable = true;
    targets.desktop = {
      credentialFile = "/Users/fruitctl-test/private/password";
      daemonPath = "/Users/fruitctl-test/Applications/qualified-native/claude-kvm-daemon";
      vnc.captureTimeoutMs = 30000;
    };
  }).home.file."Library/Application Support/fruitctl/config.json".text).success;
  linuxClipboardRejected = rejected "x86_64-linux" {
    enable = true;
    bridgeHost = "darwin-bridge";
    targets.desktop.clipboard.read = true;
  };
  clipboardTtlWithoutReadRejected = rejected "aarch64-darwin" {
    enable = true;
    targets.desktop = {
      credentialFile = "/Users/fruitctl-test/private/password";
      daemonPath = "/Users/fruitctl-test/Applications/qualified-native/claude-kvm-daemon";
      clipboard.ttlMs = 60000;
    };
  };
  linuxCaptureTimeoutRejected = rejected "x86_64-linux" {
    enable = true;
    bridgeHost = "darwin-bridge";
    targets.desktop.vnc.captureTimeoutMs = 10000;
  };
  invalidInputSourceRejected = !(builtins.tryEval (evaluate "aarch64-darwin" {
    enable = true;
    targets.desktop = {
      credentialFile = "/Users/fruitctl-test/private/password";
      daemonPath = "/Users/fruitctl-test/Applications/qualified-native/claude-kvm-daemon";
      inputSource = "-com.apple.keylayout.US\"";
    };
  }).home.file."Library/Application Support/fruitctl/config.json".text).success;
  missingDarwinCredentialRejected = rejected "aarch64-darwin" {
    enable = true;
    targets.desktop.daemonPath = "/Users/fruitctl-test/Applications/qualified-native/claude-kvm-daemon";
  };
  missingDarwinNativeRejected = rejected "aarch64-darwin" {
    enable = true;
    targets.desktop.credentialFile = "/Users/fruitctl-test/private/password";
  };
  skillRoots = builtins.filter (path: pkgs.lib.hasSuffix "skills/fruitctl" path) (builtins.attrNames linux.home.file);
  # D16/D36: provider declarations, e.g. a sops-nix materialized path.
  providerTarget = extra: {
    enable = true;
    targets.desktop = {
      daemonPath = "/Users/fruitctl-test/Applications/qualified-native/claude-kvm-daemon";
      credential = { provider = "file"; path = "/Users/fruitctl-test/.config/sops-nix/secrets/fruitctl/desktop-vnc"; };
      secrets = {
        login-password = { provider = "file"; path = "/Users/fruitctl-test/.config/sops-nix/secrets/fruitctl/login"; allowSymlink = true; };
        vault-pin = { provider = "command"; argv = [ "/nix/store/example-vault/bin/vault" "kv" "get" "-field=pin" "secret/desktop" ]; timeoutMs = 3000; };
        keychain-pass = { provider = "keychain"; service = "fruitctl-desktop"; account = "fixture-user"; };
      };
    } // extra;
  };
  providerDocument = (builtins.fromJSON (evaluate "aarch64-darwin" (providerTarget { })).home.file."Library/Application Support/fruitctl/config.json".text).targets.desktop;
  providerRejected = builtins.all (extra: rejected "aarch64-darwin" (providerTarget extra)) [
    { credentialFile = "/Users/fruitctl-test/private/password"; }
    { credential = { provider = "file"; path = "relative/password"; }; }
    { credential = { provider = "command"; argv = [ "vault" "read" ]; }; }
    { credential = { provider = "env"; name = "1BAD"; }; }
    { secrets.bad = { provider = "keychain"; service = "only-service"; }; }
    { secrets."bad ref" = { provider = "env"; name = "FRUITCTL_SECRET"; }; }
  ] && rejected "x86_64-linux" {
    enable = true;
    bridgeHost = "darwin-bridge";
    targets.desktop.secrets.login = { provider = "env"; name = "FRUITCTL_SECRET"; };
  };
in
assert builtins.attrNames fruitctlFlake.packages.aarch64-darwin == [ "default" "fruitctl" "legacy-native" "native-controller" "proxy" "runtime" ];
assert builtins.all (system: !(builtins.hasAttr "native-controller" fruitctlFlake.packages.${system})) [ "x86_64-darwin" "aarch64-linux" "x86_64-linux" ];
assert nativeController.dontBuild && nativeController.dontFixup && nativeController.dontStrip;
assert nativeController.containsHost == false;
assert nativeController.releaseMetadata.notarization.status == "Accepted";
assert nativeDocument.targets.desktop.daemonPath == "${nativeController}/bin/claude-kvm-daemon";
assert !(nativeDocument.targets.desktop ? hostHelper);
assert builtins.elem nativeController.drvPath (map (package: package.drvPath) nativeDarwin.home.packages);
assert !(nativeDarwin.launchd.agents ? fruitctl-broker);
assert !disabledDarwin.programs.fruitctl.enable && disabledDarwin.programs.fruitctl.nativePackage == null;
assert disabledDarwin.programs.fruitctl.configPath == null && disabledDarwin.programs.fruitctl.mcpServers == { };
assert builtins.all (system: let configuration = installations.${system}; in
  installationHasNoConnection configuration
  && configuration.programs.fruitctl.nativePackage == null
  && builtins.elem configuration.programs.fruitctl.package.drvPath
    (map (package: package.drvPath) configuration.home.packages)
  && installedSkills configuration == [ ".agents/skills/fruitctl" ".claude/skills/fruitctl" ".junie/skills/fruitctl" ]
  && builtins.all (root:
    configuration.home.file.${root}.source == "${configuration.programs.fruitctl.package}/share/fruitctl/skills/fruitctl"
    && configuration.home.file.${root}.recursive)
    (installedSkills configuration)
) systems;
assert installationHasNoConnection nativeInstallation;
assert builtins.elem nativeController.drvPath (map (package: package.drvPath) nativeInstallation.home.packages);
assert installServiceRejected && installTargetsRejected && installBridgeRejected && installLinuxNativeRejected && installWrongDarwinNativeRejected && installInvalidNativeRejected;
assert !(linuxWithoutService.systemd.user.services ? fruitctl-relay);
assert builtins.attrNames linuxWithoutService.programs.fruitctl.mcpServers == [ "fruitctl-desktop" ];
assert linuxWithoutService.programs.fruitctl.configPath != null;
assert linuxWithoutService.home.activation ? fruitctlSocketDirectory;
assert linux.programs.fruitctl.nativePackage == null;
assert !(builtins.hasAttr "fruitctl/config.json" linuxFiles);
assert linuxRelay.Restart == "on-failure";
assert linuxRelay.RestartPreventExitStatus == "3 78" && linuxRelay.KillMode == "control-group";
assert linux.systemd.user.services.fruitctl-relay.Unit.StartLimitBurst == 5;
assert linux.home.sessionVariables.FRUITCTL_SOCKET_PATH == linux.programs.fruitctl.socketPath;
assert linux.home.sessionVariables.FRUITCTL_BRIDGE_HOST == linux.programs.fruitctl.bridgeHost;
assert !(darwin.home.sessionVariables ? FRUITCTL_BRIDGE_HOST);
assert darwinBroker.KeepAlive == false;
assert pkgs.lib.hasInfix "--remote-socket /Users/bridge/" (builtins.head linuxRelay.ExecStart);
assert !(pkgs.lib.hasInfix "credential" (builtins.toJSON linux.programs.fruitctl.mcpServers));
assert builtins.attrNames (desktopFragment.mcpServers // secondFragment.mcpServers) == [ "fruitctl-desktop" "fruitctl-second.desktop" ];
assert pkgs.lib.hasInfix ''[mcp_servers."fruitctl-second.desktop"]'' linuxFiles."fruitctl/agents/codex/second.desktop.toml".text;
assert darwinDocument.schema == "fruitctl.config.v1";
assert darwinDocument.targets.desktop.targetId == "fixture-desktop";
assert darwinDocument.targets.desktop.inputSource == "com.apple.keylayout.US";
assert !(nativeDocument.targets.desktop ? inputSource);
assert darwinDocument.targets.desktop.vnc.captureTimeoutMs == 12000;
assert !(nativeDocument.targets.desktop.vnc ? captureTimeoutMs);
assert invalidCaptureTimeoutRejected && linuxCaptureTimeoutRejected;
assert invalidInputSourceRejected;
assert darwinDocument.targets.desktop.input == { pasteUnmappable = true; };
assert darwinDocument.targets.desktop.clipboard == { read = true; ttlMs = 60000; };
assert !(nativeDocument.targets.desktop ? input) && !(nativeDocument.targets.desktop ? clipboard);
assert linuxClipboardRejected && clipboardTtlWithoutReadRejected;
assert darwinDocument.targets.desktop.wake == { ssh = "fixture-user@fixture-target"; };
assert !(darwinDocument.targets.desktop ? desktopState);
assert !(nativeDocument.targets.desktop ? wake) && !(nativeDocument.targets.desktop ? desktopState);
assert sentinelOffDocument.wake == { ssh = "fixture-user@fixture-target"; enabled = false; };
assert sentinelOffDocument.desktopState == { ssh = "console-user@fixture-target"; enabled = false; };
assert attachmentRejected;
assert darwinDocument.targets.desktop.credentialFile == "/Users/fruitctl-test/.config/private/desktop-password";
assert helperDocument.targets.desktop.hostHelper.mapping.displayBounds.x == -1920;
assert helperDocument.targets.desktop.hostHelper.mapping.nativeWidth == 3840;
assert helperDocument.targets.desktop.hostHelper.mapping.qualificationReceipt == "fixture/owned-capture-mapping.json";
assert !(helperDocument.targets.desktop.hostHelper ? displayUuid) && !(helperDocument.targets.desktop.hostHelper.mapping ? scale);
assert !(helperDocument.targets.desktop.hostHelper.mapping ? displayUuid);
assert uuidDocument.targets.desktop.hostHelper.displayUuid == "37d8832a-2d66-02ca-b9f7-8f30a301b230";
assert !(uuidDocument.targets.desktop.hostHelper ? displayId) && !(uuidDocument.targets.desktop.hostHelper.mapping ? displayId);
assert uuidDocument.targets.desktop.hostHelper.mapping.scale == 2;
assert uuidRejected && !(rejected "aarch64-darwin" (uuidHelper uuidMapping)) && !(rejected "aarch64-darwin" (uuidHelper null));
assert darwinBroker.ProgramArguments == [ "${darwin.programs.fruitctl.package}/bin/fruitctl" "broker" "--socket" "/Users/fruitctl-test/Library/Application Support/fruitctl/run/broker.sock" "--config" "/Users/fruitctl-test/Library/Application Support/fruitctl/config.json" ];
assert builtins.elem ".agents/skills/fruitctl" skillRoots && builtins.elem ".claude/skills/fruitctl" skillRoots && builtins.elem ".junie/skills/fruitctl" skillRoots;
assert providerDocument.credential == { provider = "file"; path = "/Users/fruitctl-test/.config/sops-nix/secrets/fruitctl/desktop-vnc"; };
assert !(providerDocument ? credentialFile);
assert providerDocument.secrets.login-password == { provider = "file"; path = "/Users/fruitctl-test/.config/sops-nix/secrets/fruitctl/login"; allowSymlink = true; };
assert providerDocument.secrets.vault-pin == { provider = "command"; argv = [ "/nix/store/example-vault/bin/vault" "kv" "get" "-field=pin" "secret/desktop" ]; timeoutMs = 3000; };
assert providerDocument.secrets.keychain-pass == { provider = "keychain"; service = "fruitctl-desktop"; account = "fixture-user"; };
assert !(darwinDocument.targets.desktop ? credential) && !(darwinDocument.targets.desktop ? secrets);
assert providerRejected;
assert credentialRejected && missingBridgeRejected && noProfilesRejected && missingDarwinCredentialRejected && missingDarwinNativeRejected;
pkgs.runCommand "fruitctl-home-manager-contract" { } ''
  # Configuration assertions above run at evaluation, without native builds,
  # credential reads, SSH, service startup or a Home Manager switch.
  touch "$out"
''
