# Secret providers

Fruitctl needs secrets in two places: the VNC/ARD credential the controller
uses to reach a target, and the values an agent types into target fields with
`type_secret`. Both are read by the Darwin broker from a source you already
run, such as sops-nix, a vault CLI or the login keychain. The Linux relay, the
agent, tool arguments, logs, the journal and generated MCP configuration never
contain a secret value.

## Providers

Each declaration names one provider. Unknown keys are refused when the
configuration loads, so a typo cannot silently drop a check.

| Provider | Fields | What the broker does |
| --- | --- | --- |
| `file` | `path`, optional `allowSymlink` | Reads an exact file, for example a sops-nix materialized secret. |
| `env` | `name` | Reads a variable from the broker's environment. Discouraged. |
| `command` | `argv`, optional `timeoutMs` | Runs an explicit argv without a shell. stdout is the secret. |
| `keychain` | `service`, `account`, optional `keychain` | Runs `/usr/bin/security find-generic-password -s SERVICE -a ACCOUNT -w` (Darwin only). |

Every provider returns nonempty UTF-8 without NUL, at most 4,096 bytes. One
trailing newline (`\n` or `\r\n`) is removed; other whitespace is kept.

**file.** `path` is absolute. The file must be a regular file owned by the
broker user, with no group or other access (`0600` or `0400`). Its directory
must be owned by that user or root and must not be writable by group or
others. By default the path must not itself be a symlink. `allowSymlink: true`
follows it, and the resolved file passes the same checks. The file is opened
without following a final link, and the checks run on the opened file, so the
file cannot be swapped between check and read. Paths of the sops-nix Home
Manager module (`config.sops.secrets.<name>.path`) are regular files below a
symlinked directory, which is accepted without `allowSymlink`. A custom
sops-nix `path` is a symlink and needs `allowSymlink = true`.

**env.** The broker reads `name` from its own environment. Use it only when
nothing else fits: launchd and systemd environments are easier to inspect than
a private file. `fruitctl doctor --secrets` warns `env_provider_discouraged`.
The broker removes every env-provider variable, and `VNC_PASSWORD`, from the
environment of the native controller and of every provider command.

**command.** `argv[0]` must be an absolute executable. The arguments are
passed literally; no shell expands them. stdin is closed and stderr is never
opened, so tool diagnostics are not read or logged. stdout is limited to the
secret size. The command is killed after `timeoutMs` (100 to 10000, default
5000) or when the request is cancelled. A nonzero exit fails with
`exit_status`. This is the vault-agnostic adapter, for example:

| Source | `argv` |
| --- | --- |
| HashiCorp Vault | `["/usr/local/bin/vault", "kv", "get", "-field=password", "secret/desktop"]` |
| 1Password | `["/usr/local/bin/op", "read", "op://Desktop/login/password"]` |
| Bitwarden | `["/usr/local/bin/bw", "get", "password", "desktop-login"]` |
| sops | `["/usr/local/bin/sops", "-d", "--extract", "[\"desktop\"][\"password\"]", "/Users/alex/secrets.yaml"]` |
| Keychain (explicit) | `["/usr/bin/security", "find-generic-password", "-s", "desktop", "-a", "alex", "-w"]` |

Use store paths (`"${pkgs.vault}/bin/vault"`) in Home Manager. The command
runs as the broker user with the broker's environment, minus the removed
variables, so its own session or token must already be valid.

**keychain.** Darwin only; other platforms fail with `unsupported_platform`.
A missing item fails with `missing`. The item's access control must allow
`/usr/bin/security` without a prompt. Otherwise macOS shows a dialog on the
controller and the read times out after 5 s.

## VNC credential

`targets.<name>.credential` declares the provider of the target's VNC/ARD
password. `credentialFile: "/path"` remains a backward-compatible alias for
`{ "provider": "file", "path": "/path", "allowSymlink": true }`. Declare one
or the other, not both. The broker resolves the credential when it starts the
native controller and passes it over the controller's private credential
descriptor. A failure is reported as `credential_unavailable` with the
provider kind and reason, for example
`VNC credential provider file failed: mode_too_open`.

## type_secret

`targets.<name>.secrets` is the per-target allowlist (D16): ref name to
provider. An agent can type only these refs, and only by name:

```json
{"action":"type_secret","ref":"login-password","x":640,"y":400}
```

`x` and `y` are optional. When present, the controller left-clicks there to
focus the field first. Then:

- The relay and MCP client forward only the ref. A request that carries
  `text`, `secret` or any other field is refused with
  `invalid_secret_request`.
- A ref that the target does not allowlist is refused with
  `secret_ref_not_allowed`. A provider failure is refused with
  `secret_unavailable`, naming the ref, provider kind and reason. Nothing is
  sent to the target, and the session keeps its lease.
- The batch joins the target's queue in arrival order. The broker runs the
  provider only after every refusal that sends nothing has passed: the
  desktop-state sentinel, the backend's capabilities, the route and the Stop
  latch. A refused batch never reads its secret.
- The broker resolves the value and hands it to the native controller as a
  private request field on its stdin pipe. The controller plans every
  character before sending anything, so an untypable secret sends neither the
  click nor any key. It then types through the ordinary input path, including
  the input-settle gate. It never uses the clipboard (D29).
- On the Host route, the broker renews the Host lease immediately before
  typing. A Stop latched before the call is refused with
  `human_stop_latched`. A Stop or expired lease at that renewal fails the
  call before any keystroke.
- The result is `OK` or a typed error with a fixed message. A failure after
  typing began says the field may hold part of the secret. Native text is
  never echoed.
- The journal records `{ref, x, y, provider, length_class}`, where
  `length_class` is `1-8`, `9-16`, `17-32`, `33-64` or `65+` characters.
  The value is never recorded.

Never allowlist a secret for consent dialogs. `type_secret` does not answer
macOS privacy (TCC) prompts, administrator authentication or keychain access
dialogs. Those belong to the target's human owner.

## sops-nix example

```nix
{ config, pkgs, ... }: {
  sops.secrets."fruitctl/desktop-vnc" = { };
  sops.secrets."fruitctl/desktop-login" = { };

  programs.fruitctl.targets.desktop = {
    vnc = { host = "127.0.0.1"; port = 15900; username = "alex"; };
    credential = {
      provider = "file";
      path = config.sops.secrets."fruitctl/desktop-vnc".path;
    };
    secrets = {
      login-password = {
        provider = "file";
        path = config.sops.secrets."fruitctl/desktop-login".path;
      };
      vault-pin = {
        provider = "command";
        argv = [ "${pkgs.vault}/bin/vault" "kv" "get" "-field=pin" "secret/desktop" ];
        timeoutMs = 3000;
      };
    };
  };
}
```

Paths stay strings in the generated `config.json`; Nix never reads their
contents. A Linux seat declares target names only. Its relay forwards ref names
to the Darwin broker and has no `credential` or `secrets`.

## Checking providers

```sh
fruitctl doctor --secrets [--target PROFILE] [--config PATH]
```

This runs on the broker host. It resolves each declared credential and secret
once, then discards the value. It prints only the provider kind and `ok`,
`fail` with a reason, or `absent`. The `secretsCheck.status` is `fail` when any
provider fails (exit 1) and `warn` when an env provider is declared. Reasons
are `missing`, `permission_denied`, `symlink_refused`, `not_regular_file`,
`not_owner`, `mode_too_open`, `unsafe_parent`, `too_large`, `empty`,
`invalid_encoding`, `unset`, `timeout`, `exit_status`, `spawn_failed`,
`unsupported_platform` and `cancelled`. Command and keychain checks run the
real tool, so a vault session must be valid when you run the doctor.
