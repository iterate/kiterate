# kiterate

We're going to make an extremist AI agent and learn effect!

# In what way is this agent extremist?

Agents only support 
- `.append({ event })` and
- `.stream({ offset, live })`.

And consequently their `AgentManager` only supports something like 
- `.append({ agentPath, event })` and 
- `.stream({ agentPath, offset, live })`.

Everything is an event
- normal LLM stuff like input/output items, including streaming text or even PCM audio chunks
- configuration (e.g. which LLM(s) to use with which parameters)
- the source code of functions the agent can call!
- log lines and errors
- external events (e.g. slack webhooks that the agent responds to)
- agent-to-agent subscriptions
- maybe even the schemas of allowed events!
- maybe even the source code of "plugins" (if we have such a thing)! 

Any state that is required to e.g. render boxes in a UI or produce the payload for the next LLM request is a projection/reduction of the event stream.

"user message" and "assistant message" doesn't make sense for our agents. They aren't primarily for 1on1 conversations. They are magic general purpose software that can receive events (think: webhooks) indicating that something happened and then react to them by writing typescript code (we call this codemode!) which invokes what you'd think of as "tools".

Agents start implicitly and never end. You can always add another event! It might wake them and their listeners up. And agents are implicitly created. Anything you'd normally pass to an agent (e.g. which model to use or what the system prompt is) can just be included in the initial batch of events.

Everything is delightfully and dangerously evented and decoupled and asynchronous and debounced. Maybe we won't even have `append({ events })` (plural)!

For example, the code that makes an LLM request can be written as a subscriber to a stream - rather than awkwardly part of it. When it sees an event with `{ triggerAgentTurn: "immediately" }`, it does some debouncing and makes an LLM request, which adds an event of type `llm-request-started` (and possibly llm-request-interrupted etc). Heck, maybe there's even two separate LLM requests that are made (that might be really good - see below!). But of course this means you can easily get infinite loops etc.

The agent deliberately only depends on a limited set of well defined dependencies:
1. a way to store and retrieve events 
    - from the filesystem, sqlite, clickhouse, whatever!
2. fetch
    - used to mutate the world - also used to message other agents via POST /agents/{path}
3. exec-ish
    - optional, to do stuff on a computer (if present)
4. eval-ish
    - required to run the code the agent produces 
5. env vars
    - all other configuration is in events - just not env vars as they might contain secrets (though in our particular case they won't...)

The agent is designed to run in weird and wonderful environments - doesn't matter if it's a nodejs process on a big machine, a browser extension, a cloudflare durable object, or various flavours of pretend world in tests and evals.

It's also designed for stateful LLM transports - specifically realtime voice via websockets (though in the future surely video is next).

And finally, this agent is designed entirely for self-transmogrification and emergent behaviour. It should be able to read its own events and have access to it's own `append` API.

And it's written in effect!

# What does this give us?

Lots of fun stuff! Most importantly, a foundation that lets us express all our whackiest ideas in terms of the same simple primitives.

**Debuggability**
: The core is small and rarely changes. EVERYTHING ELSE is in events. If you have an agent trace, you (or more likely an AI agent) can work out where stuff went wrong. There's no need for third party tracing or anything - just make a nice local trace viewer and be done with it.

**Self-modification**
: Agents can modify themselves at runtime! Even if they have no file-system (like in a durable object or browser extension), they can just append an event to fix a bug in a tool, make themselves a new tool, or give another agent a cool tool.

**Runtime flexibility**
: The agent can run in weird and wonderful environments - nodejs process, browser extension, cloudflare durable object, or various flavours of pretend world in tests and evals.

**Multi-LLM loops**
: We believe in the future AI agents will make multiple LLM requests per "loop" - one to decide what to do and multiple others to check various safety aspects (or perhaps do "best-of-n" generation). This is easy to model without changing a lot. Just add a hook to your codemode subscriber that stops it from running any code in response to an LLM request, until the safety LLMs all gave the all-clear

**Codemode workflows!**
: What if some functions that the LLM-writen codemode code calls need human approval? With this event-sourced design, we could say that, actually, every codemode block is a _workflow_ block and every invocation of `fetch()` or `exec()` is a _step_  in a workflow. Resumable long running workflows are v easy to model using an event stream and event replay!

### Quick note on the events stuff

I concede that there's a limit to this philosophy of everything being an event. The typescript type system doesn't know about the contents of events, for example. And even though we _could_ it probably doesn't make sense to include _all_ our core logic as events on _all_ agents (or does it?!)

BUT: It's much easier to start this way, and then loosen up. You can always say "Oh well, actually let's tell the type system about all the allowed event types" or "Let's just have the events point at functions that are provided by the runtime environment" etc

So let's try and think of as much stuff as possible as an event - this means it could theoretically be produced as the result of any codemode code that the LLM came up with!


# So what will we actually build concretely?

I've already made a repo structure with three folders: `server`, `web` and `cli`.

Each will contain many different versions of servers and clients that we create over the week. They should be mix-and-matchable because the API is always just a durable stream.

**Over the course of the week we'll implement MANY separate `server/` backends, as well as probably a few `web/` and `cli/` frontends — so we can experiment with ideas, compare implementations, and iterate rapidly.**

## Development

```bash
pnpm dev [backend] [frontend]
```

| Command | Backend | Frontend |
|---------|---------|----------|
| `pnpm dev` | basic | shiterate |
| `pnpm dev basic` | basic | shiterate |
| `pnpm dev basic-with-pi` | basic-with-pi | shiterate |

- **Backend** runs on port 3001
- **Frontend** runs on port 3000

To add a new backend or frontend, edit `dev.mjs`:

```javascript
const BACKENDS = new Map([
  ["basic", "@kiterate/server-basic"],
  ["basic-with-pi", "@kiterate/server-basic-with-pi"],
  // Add new backends here
]);

const FRONTENDS = new Map([
  ["shiterate", "@iterate-com/daemon"],
  // Add new frontends here
]);
```

## Current implementations

`server/basic`: A simple event stream server with YAML-based storage.
- POST /agents/:path - Append event (auto-creates stream)
- GET /agents/:path?offset=-1&live=sse - Read events

`server/basic-with-pi`: Wraps basic server and adds PI coding agent integration for /agents/pi/* paths.

`web/shiterate`: A web frontend to interact with the server

`cli/basic`: A CLI to interact with the server
- `./main.ts [--url http://localhost:3001] <agent-path> append {json-event}`
- `./main.ts [--url http://localhost:3001] <agent-path> stream [--offset X] [--live]`


By the end of the week I'd like to
- Have a decent understanding of effect
- Have a great setup for testing and iterating on agent designs
- Have thought through the design of ALL the things on the list below
- An opentui / atom / effect TUI CLI skeleton we can build on
- Have implemented as many of them as we get to 

And, more concretely, have given my iterate agent in my iterate project a voice!

**I should be able to talk to my iterate agent using our new loop w/ realtime voice streaming and codemode!**

That is the fun motivating outcome! Then we can hook up a physical button to it and talk to our iterate whenever we like!

## Layering the onion from the inside out

I'm imagining we'll build this from the inside out as layers of an onion

### Level 0: A basic effect harness

Before we do anything else, I want a solid effect scaffolding of the project. Service and API definitions, tests, a durable stream that does nothing at all, etc

We can start with just a basic multiplexing `Stream`. It depends on nothing, only returns whatever errors the underlying effect primitives might emit, and does v little other than 

`.stream()` and `.append()`

Before we build anything more, I want good tests for this level 

### Level 1: A durable stream
    - depends on storage APIs
    - emits new storage errors
    - `append` and `stream` methods that wrap the `Stream` methods and add storage

### Level 2: A durable stream with hooks
    - `withHooks(DurableStream)`? Not sure
    - before hook can fail and cause error events
    - not sure we actually need an after hook - that's just a stream subscriber!
    - at this level we need to deal with wakeup / resume

### Level 3: An agent
    - when certain events occur, we make an LLM request and add `llm-request-started` and `llm-request-completed` events etc
    - introduces lots more events for LLM context, output items, streaming chunks etc
    - Depends on an LLM transport that has append, stream and, crucially, an optional `connect` method to support websocket realtime voice APIs
    - Depends on fetch and env vars for the first time
    - At this level we should deal with "interruptions"

Before we go any further, I'd like to get some tablestakes agent features implemented here and well-tested:

- auto-resume sessions after restart
- auto-retry LLM requests
- debouncing
- interruption handling
- basic circuit breaking / runaway protection
- OTEL tracing to e.g. langfuse
- modeling errors in the stream
- validating event schemas appended to the stream (do we not care at a global level? do just the subscribers that care validate and then add an "invalid event" event?!)
- support for reasoning items across LLM providers
- graceful shutdown / restart of agent server (means we need some way of knowing whether the agent is "idle" - needs to be expressed as event probably?)

Though I could also be convinced to do codemode first and then do these one by one.


### Level 4: An agent with codemode tool calling
    - when the LLM makes an assistant response with a triple backticks block (or perhaps a `codemode` function toolcall), we parse the code, typecheck it and run it! 
    - adds new events with types like `codemode-block-started` and `codemode-block-completed` and `codemode-block-error` etc
    - the only thing codemode execution can do is ... adding events! Some of which might trigger more LLM requests etc.
    - depends on some way to run code and `exec` and `fetch` and env vars!

### Level 5+ 

Now the tech tree really opens up. We can get into all of these "tablestakes" agent harness features. With lots of it we can honestly just borrow from the excellent work Mario Zechner did with pi coding agent.

We should now be able to build out a lot of "nuts and bolts" of agents fairly easily. And if we can't build it all in a week, we should design it

**Compactions**
: Should be able to support v long conversations

**Messaging other agents**
: Is just a fetch call, but we can wrap it in nicely typed function.

**Subagents**
: This is just making an agent in a sub-path with some tools that let it talk to the parent agent.

**Tests with mocked LLM responses**
: We need to be able to write "failing tests" for our agent system that mock real LLM responses. Ideally we'd have a mechanism for "stealing" a real trace and turning it into a failing test.

**Agent-to-agent evals**
: I'd to build a mechanism where one agent instance can eval another agent instance. I think this will be fairly easy to do and means we can model evals as (events for evalutor, events for evaluatee, scoring function).

**Multimodal input**
: We need to find a way to "show" images (or in the case of gemini - video and audio?) to an LLM. A good pressure test of our abstractions.

**MCP**
: Connecting to MCP servers via oauth etc

**Human in the loop approvals**
: Since we consider the sandbox already compromised, disposable, dead, we don't even care about exec. And at that point, human approval policies are just web firewall and egress rules - a well understood concept. But need to come up with some event types etc to model this (and maybe combine with workflow codemode)


### Level 6: More esoteric stuff

We will likely not get to build this - but it's good to discuss how we _might_ to pressure test our low level primitives

**Workflow codemode**
: Where each function invocation might take a long time and require a human approval event. 

**Circuit breaking**
: Agents can easily get into infinite loops in this construction. We need to detect that - highly non-trivial esp when multiple agents involved.

**Durable agent-to-agent subscriptions**
: Agent A can add an event to Agent B, subscribing to a (filtered?) stream of its events. This means if anythign happens to agent B, agent A will know. Massive infinite loop potential here! 

**Multi-LLM for safety**
: We want to be able to make multiple LLM requests in parallel - one for the main LLM and a few others for prompt injection protection

**Multi-LLM for best-of-n**
: We want to be able to make multiple LLM requests in parallel - one for the main LLM and a few others for best-of-n generation.

**Multi-LLM for better interruption handling**
: What if, while one LLM request was in progress and reasoning hard, we could kick off a second parallel one to answer some user query that came in? Like optimistic concurrency for LLM requests. The threads just merge together once there is no ongoing LLM request for a moment!

**Wrapping up our agent in a workflow**
So that we can build a SaaS where the main "work" is done by an agent that gets a `taskDone` tool that hits a callback on our SaaS server. This will "just work" but would be cool to prove it.

**Forking of agents**
: Lots of agents treat events like a tree structure with a "parent pointer". So you can fork streams at any point in the past and continue from there. This raises the interesting question: Can one event be in multiple streams? Or does it get copied into each stream? I THINK we should just copy the events, in which case this is trivial?!

**Agent to event stream mapping**
This isn't so much about our agent loop, but worth thinking of. In realitiy, the "agent path" is a stable logical identifier that can be used for a long time. But internally, it should just have a pointer at an EventStream. Then when it's bricked that old stream or its too long or whatever, some external system can detect it (or the agent can request it), and we can point it at a new stream. The new stream can even have an event that says "You bricked your old stream but here's how you sift through it"


# Interesting design questions

While it may seem like I think we've worked it all out, it's actually quite the opposite. I think this is the right general direction, but I have no idea what _exactly_ we need to do. Lots of headscratchers come up every time I think about this.

- How should we deal with event schemas and type safety in general? Should schemas be events?! Who enforced what schema where? DurableStream enforces that `offset` exists.

- How are codemode blocks typechecked? Where do the types come from? 

- What do we do about projections / reducers? Does every interested party just maintain their own reduced state? Is this a first class primitive? Or just something subscribers do?

- What if you need to ensure the subscribers run in a certain order? I guess then you'd need the first subscriber to emit an event that the second one can listen to?!

- How much do we try or don't try to abstract the differences of LLM providers? We know we want to treat the verbatim streaming chunks and other vendor-specific formats as events. But do we ALSO invent some meta level?

- How do we handle image files? They often need to be uploaded to the LLM provider in some awkward way - might need a special abstaction for that

- How much of our core code should be in events? What are the bull and bear cases for putting even our core logic into events as strings of code? What if "giving the agent the ability to use [new inference provider X]" is just adding events?

- How do we do "single turn mode" in the CLI? Since there is no direct connection between append and events streaming back, it might be "append + wait for next idle"?

- Do we use effect's _tag instead of `type` properties?! And general taxonomy and envelope format questions... EventStream or ContextStream etc. 