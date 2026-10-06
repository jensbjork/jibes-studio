# Connecting your own agent (MCP)

Studio can run a [Model Context Protocol](https://modelcontextprotocol.io) server so that AI agents you run
yourself — for example OpenClaw, Hermes Agent, Claude Desktop or Claude Code — can work in the app alongside you.
An agent can read the library and look at its photos, choose reference images, write and validate prompts, fill in
the Generate form and build sequences. Everything an agent prepares is free.

**An agent can never spend money on its own.** The three paid tools only create an *approval request*. Studio
shows it to you with the prompt, the reference images and the price, and nothing is sent to Venice until you click
*Godkänn och generera* (approve and generate).

- [Enabling the server](#enabling-the-server)
- [Addresses and token](#addresses-and-token)
- [Client configuration](#client-configuration)
- [Tools](#tools)
- [The approval flow](#the-approval-flow)
- [Prompt-writing guidance](#prompt-writing-guidance)
- [Troubleshooting](#troubleshooting)

## Enabling the server

1. Open **Inställningar → Agentanslutning** (Settings → Agent connection).
2. Switch on **Tillåt agenter att ansluta** (allow agents to connect). It is **off by default**, and the setting is
   per profile: Studio Dev and Studio.app each have their own switch, port and token.
3. The status line shows where Studio listens. The indicator at the bottom of the sidebar shows whether an agent is
   connected; click it to open the activity drawer with every tool call and the pending requests.

The first time Studio listens on the Tailscale address, the macOS firewall may ask whether to allow incoming
connections — answer *Allow*.

## Addresses and token

The server speaks **MCP over Streamable HTTP** at the path `/mcp`, on port **8770** unless you choose another one
(1024–65535) in the same section. It listens on exactly these addresses and never on your LAN or `0.0.0.0`:

| Address | For |
| --- | --- |
| `http://127.0.0.1:8770/mcp` | Agents running on the same Mac. |
| `http://100.x.y.z:8770/mcp` | Agents on other devices in your [Tailscale](https://tailscale.com) tailnet (this Mac's Tailscale IPv4). |
| `http://<your-mac>.<tailnet>.ts.net:8770/mcp` | The same, by MagicDNS name, when Studio can resolve it. |

Settings shows the actual addresses with copy buttons. Traffic is plain HTTP: loopback never leaves the Mac, and
Tailscale traffic is encrypted by WireGuard.

Every request needs Studio's token:

```
Authorization: Bearer <token>
```

The token is a random 256-bit value, stored encrypted in the macOS Keychain. Show, copy or replace it in the
**Token** field. Replacing it (*Byt token…*) disconnects every connected agent and expires their pending requests.

Optionally, send `X-Studio-Agent-Name: <name>` to choose the name Studio shows in the activity log and the approval
dialog (otherwise it uses the name the MCP client reports, which may be generic).

## Client configuration

Settings → Agentanslutning shows ready-made snippets for OpenClaw and Hermes Agent with your address, and its copy
buttons include the real token. The examples below use placeholders: replace `<token>` and the URL. Treat the token
like a password and keep it out of files you commit or share.

### OpenClaw

Merge into OpenClaw's configuration under `mcp.servers`:

```json
{
  "mcp": {
    "servers": {
      "studio": {
        "url": "http://100.x.y.z:8770/mcp",
        "transport": "streamable-http",
        "headers": {
          "Authorization": "Bearer <token>",
          "X-Studio-Agent-Name": "OpenClaw"
        }
      }
    }
  }
}
```

### Hermes Agent

Hermes Agent connects over HTTP as well. Add the server to its configuration (YAML); check Hermes's documentation
for the exact key, which may differ between versions:

```yaml
mcp_servers:
  studio:
    url: "http://100.x.y.z:8770/mcp"
    headers:
      Authorization: "Bearer <token>"
      X-Studio-Agent-Name: "Hermes"
```

### Claude Code

Claude Code supports remote HTTP servers with headers directly:

```bash
claude mcp add --transport http studio http://127.0.0.1:8770/mcp \
  --header "Authorization: Bearer <token>" \
  --header "X-Studio-Agent-Name: Claude Code"
```

Or in a project's `.mcp.json`, reading the token from the environment so it is never committed:

```json
{
  "mcpServers": {
    "studio": {
      "type": "http",
      "url": "http://127.0.0.1:8770/mcp",
      "headers": {
        "Authorization": "Bearer ${STUDIO_MCP_TOKEN}",
        "X-Studio-Agent-Name": "Claude Code"
      }
    }
  }
}
```

### Claude Desktop

Claude Desktop's configuration file starts local (stdio) servers, so bridge to Studio with
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote). In
`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "studio": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://127.0.0.1:8770/mcp",
        "--transport", "http-only",
        "--header", "Authorization:${STUDIO_AUTH}",
        "--header", "X-Studio-Agent-Name:Claude"
      ],
      "env": { "STUDIO_AUTH": "Bearer <token>" }
    }
  }
}
```

`mcp-remote` only allows plain `http://` for `localhost`/`127.0.0.1`; to reach Studio over Tailscale from another
Mac, use the `100.x.y.z` or `.ts.net` URL and add `--allow-http`. Restart Claude Desktop after editing the file.

### Any other MCP client

Any client that supports **Streamable HTTP** with custom headers works: point it at the URL and send the
`Authorization` header. Clients that only support stdio can use `mcp-remote` as above. Browser-based clients cannot
connect (see [Troubleshooting](#troubleshooting)).

## Tools

Studio offers 26 tools, one prompt and one resource. Tool errors come back as readable tool errors; their messages
are in Swedish, like the app's UI. Tools that touch the library fail with an explanation until a library is open,
and the tools that read or fill the Generate form need the Studio window to be open.

### Read (change nothing)

| Tool | What it does |
| --- | --- |
| `get_studio_guide` | How Studio works and how to write video prompts for it. Read once at the start of a session. |
| `get_workspace` | What the user is looking at (view, open sequence and clip) and the Generate form: mode, model, settings, prompt, reference token map, validation issues, price. |
| `list_assets` | Characters, environments and outfits with ids, descriptions, photo ids and default outfits; optional `kind` filter. |
| `get_asset` | One asset with its photos as images (JPEG, at most 768 px), each labelled with its photo number and `image_id`. |
| `list_models` | Venice's usable video models (optionally one `kind`) with mode, durations, resolutions, aspect ratios, reference image limit, audio and prompt length limit; the default model is marked. |
| `list_prompts` | The prompt library, favourites first. |
| `list_generations` | The latest generations (`limit` 1–50, default 10) with status, prompt, settings, price and error. |
| `get_generation` | One generation with its token map, the clip it is a take of, its poster frame and optionally up to 6 `frames` from the video. |
| `list_sequences` | Sequences with clip count and the length of the current cut. |
| `get_sequence` | One sequence with its clips, each clip's token map, continuation flag, validation issues and selected take; poster frames with `include_thumbnails` (default true). |
| `validate_prompt` | Checks a prompt's `@ImageN` tokens against the form's references or a given set — the same check Studio applies before every paid generation. |
| `get_approval` | The state of an approval request: `pending`, `approved` (with `generation_ids`), `declined`, `expired` or `failed`. |

### Write (free; change the library or the form)

| Tool | What it does |
| --- | --- |
| `set_form` | Fills in the Generate form (mode, model, duration, resolution, aspect ratio, audio, prompt, negative prompt, start image) and shows the Generate view. All or nothing: invalid values change nothing. |
| `set_references` | Sets the form's reference images from assets (all photos or chosen `image_ids`, `replace` or `append`) and returns the token map to write the prompt with. |
| `open_in_studio` | Brings the Generate view or a sequence (optionally one clip) to the front. |
| `create_asset` | Creates a character, environment or outfit with a name and description. Photos can only be added by the user in Studio. |
| `update_asset` | Changes an asset's name, description or (characters) default outfit. Renaming also renames its folder. |
| `save_prompt` | Saves a prompt to the prompt library. |
| `create_sequence` | Creates an empty sequence with the default settings. |
| `add_segment` | Adds a clip (prompt, references, model and options, `continue_from_previous`), validated like a generation. |
| `update_segment` | Changes a clip; only the fields passed change. Existing takes are kept. |
| `delete_segment` | Removes a clip (marked destructive). Its takes are kept as ordinary generations. |
| `move_segment` | Moves a clip to another position (`to_clip_number`, 1-based). |

While *Generera saknade* runs for a sequence, agents cannot change its clips.

### Paid (create an approval request; nothing is generated until the user approves)

| Tool | What it asks for |
| --- | --- |
| `request_generation` | Generating the Generate form as it is now (captured at request time). |
| `request_segment_generation` | A new take of one sequence clip. Lapses if the clip changes before approval. |
| `request_generate_all` | Every clip of a sequence without a finished selected take, in order; the price is the sum. Lapses if the clips change. |

Each takes an optional `note` (up to 500 characters) that is shown to the user in the approval dialog.

### Prompt and resource

| Name | Kind | What it is |
| --- | --- | --- |
| `write_video_prompt` | MCP prompt | Starts a prompt-writing task (optional `idea`, optional `segment_id`) with the actual reference token map and the prompt-writing guide. |
| `studio://guide` | MCP resource (Markdown) | The same guide as `get_studio_guide`. |

### What agents cannot do

Agents cannot add or remove photos, delete assets, prompts, generations or sequences, rename sequences, export,
change settings, switch the library, or approve anything. Every change goes through the same services as the
window, with the same validation.

## The approval flow

1. The agent prepares the form or a clip and calls a paid tool. Studio validates it first (prompt, start image or
   references, `@ImageN` tokens); a problem comes back as an error and no request is made.
2. Studio asks Venice for the price and creates the request. The tool answers at once with
   `{approval_id, status: "pending", price_usd, expires}`. Asking again for exactly the same thing returns the same
   request; a new request for the same clip replaces an older pending one. At most 10 requests can wait at a time.
3. Studio shows the approval dialog with the prompt, the reference images, the price and the agent's note. If Studio
   is not in front, its Dock icon bounces once. Pending requests are also listed in the activity drawer.
4. You approve or decline (optionally with a reason). On approval Studio re-checks that the clips and the image
   files are still exactly what was shown (the Generate form was captured when the request was made, so later
   edits to the form don't change it), then submits through the normal generation path. If Venice first needs you
   to accept a model's terms, the consent dialog appears; accepting it submits the request, and until then the
   request stays pending.
5. The agent polls `get_approval` (every 15–30 seconds is plenty) and then follows the result with
   `get_generation` or `get_sequence`.

A request **expires** after 30 minutes without an answer, and immediately when the token is replaced, the library
is switched or the agent connection is switched off.

## Prompt-writing guidance

The server's `initialize` instructions ask agents to start with `get_studio_guide`. The guide (also available as
the `studio://guide` resource and through the `write_video_prompt` prompt) explains assets, the three modes,
`@ImageN` references, sequences and continuation clips, approvals, and how to write prompts for Seedance-class video
models. Agents are asked to talk to the user in Swedish and to write video prompts in the language chosen under
**Inställningar → Promptspråk** (English by default).

## Troubleshooting

**Tailscale is not found.** Studio looks for Tailscale's tunnel interface (a `utun` interface with a single
`100.64.0.0/10` IPv4 address next to an `fd7a:115c:a1e0::/48` IPv6 address); other VPNs or networks that happen to
use `100.x` addresses are deliberately ignored. Make sure Tailscale is running and connected, then press
*Sök igen* (search again) in Agentanslutning — Studio also re-checks every 30 seconds. Until then only agents on the
same Mac can connect.

**The port is in use.** Studio reports that the port is used by another program. Choose another port in
Agentanslutning and update your agents' URLs. Note that Studio.app and Studio Dev both default to 8770, so give one
of them another port if both have the connection switched on. To see what holds the port:
`lsof -nP -iTCP:8770 -sTCP:LISTEN`.

**Studio could not listen on the Tailscale address.** The connection still works on `127.0.0.1`; the status line
explains the error. Check the macOS firewall (System Settings → Network → Firewall) and allow Studio.

**HTTP 401 Unauthorized.** The `Authorization: Bearer <token>` header is missing or the token is wrong — typically
after *Byt token…*. Copy the current token from Agentanslutning.

**HTTP 403 Forbidden.** The request came from an address that isn't allowed on the socket it reached: the
loopback address only serves this Mac, and the Tailscale address only serves tailnet peers (not devices on a LAN
that happens to use `100.x` addresses). Use one of the addresses listed in Settings.

**HTTP 403 "Browser access is not allowed".** The request carried an `Origin` header. Web pages and browser-based
clients are refused by design; use a native MCP client or `mcp-remote`.

**HTTP 404 Not found** means the path is not `/mcp`. A JSON-RPC error *Session not found* (also 404) means Studio
was restarted or the session was closed; a well-behaved client starts a new session automatically.

**HTTP 413** means the request body was larger than 1 MB.

**"Studio-fönstret svarar inte – är det öppet?"** ("the Studio window doesn't answer — is it open?"): the form
tools need the window. On macOS, closing the window keeps Studio running; click its Dock icon to open it again.

**"Studio har inget bibliotek öppet"** (Studio has no library open): choose a base folder in Studio first.

To test the connection by hand, an `initialize` request should return `200` and an `mcp-session-id` header:

```bash
curl -i http://127.0.0.1:8770/mcp \
  -H "Authorization: Bearer $STUDIO_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```
