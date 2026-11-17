import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { TooltipProvider } from "@/components/ui/tooltip";
import { isDemoBackend } from "@/base/demo-banner";
import { request, token } from "@/base/request";
import { SessionDialog } from "@/base/session-dialog";
import { SessionProvider, useSession } from "@/base/session";
import { Avatar, AvatarStack, SplitView, shortDate } from "@/components/kit";
import { shellContent } from "@/components/kit/app-shell";
import { Person } from "@/components/workspace/person";
import { cn } from "./utils";

afterEach(cleanup);

describe("the shell's content area", () => {
  it("is a reading column, then the full width, then the whole pane", () => {
    expect(shellContent({}).column).toContain("max-w-6xl");
    expect(shellContent({ wide: true }).column).toContain("max-w-none");
    const bleed = shellContent({ bleed: true });
    expect(bleed.column).not.toMatch(/\bp-\d/);
    expect(bleed.pane).toContain("overflow-hidden");
  });
});

describe("the demo banner", () => {
  it("shows on a Xano Engine and an ephemeral build, and nowhere else", () => {
    expect(isDemoBackend("http://127.0.0.1:55325", "production")).toBe(true);
    expect(isDemoBackend("http://abc.localhost:55325", "production")).toBe(true);
    expect(isDemoBackend("https://x1.xano.io", "ephemeral")).toBe(true);
    expect(isDemoBackend("https://x1.xano.io", "production")).toBe(false);
  });
});

describe("who's who", () => {
  it("takes the kind as the backend says it, so nobody has to translate", () => {
    const { container } = render(<><Avatar name="Scout" kind="agent" /><Avatar name="Ada" kind="human" /><Avatar name="Eli" kind={null} /></>);
    expect([...container.querySelectorAll("[data-slot=avatar]")].map((a) => a.getAttribute("data-kind"))).toEqual(["agent", "person", "person"]);
  });
  it("gives an agent's name the violet square and the Agent tag, and a person neither", () => {
    const { container } = render(<><Person name="Scout" kind="agent" /><Person name="Ada" kind="human" /></>);
    const [agent, person] = [...container.querySelectorAll("[data-slot=person]")];
    expect(agent.querySelector("[data-slot=avatar]")!.className).toContain("rounded-[28%]");
    expect(agent.querySelector("[data-testid=agent-mark]")?.textContent).toBe("Agent");
    expect(person.querySelector("[data-slot=avatar]")!.className).toContain("rounded-full");
    expect(person.querySelector("[data-testid=agent-mark]")).toBeNull();
  });
  it("can say a different name, or none at all beside the face", () => {
    render(<Person name="Scout" kind="agent" label="You" />);
    expect(screen.getByText("You")).toBeTruthy();
    const { container } = render(<Person name="Scout" kind="agent" face={false} />);
    expect(container.querySelector("[data-slot=avatar]")).toBeNull();
    expect(container.querySelector("[data-testid=agent-mark]")).not.toBeNull();
  });
  it("makes a person round and an agent a rounded square, and says which", () => {
    render(<><Avatar name="Ada Admin" /><Avatar name="Scout" kind="agent" /></>);
    expect(screen.getByRole("img", { name: "Ada Admin" }).className).toContain("rounded-full");
    const agent = screen.getByRole("img", { name: "Scout (agent)" });
    expect(agent.className).not.toContain("rounded-full");
    expect(agent.className).toContain("bg-agent-wash");
  });

  it("keeps an agent's shape in a stack", () => {
    const { container } = render(<AvatarStack names={["Ada", { name: "Scout", kind: "agent" }]} />);
    expect(container.querySelector('[data-kind="agent"]')?.className).toContain("bg-agent-wash");
  });
});

describe("cn", () => {
  it("keeps a type role beside a colour, which plain tailwind-merge would read as a clash", () => {
    expect(cn("text-body", "text-muted-foreground")).toBe("text-body text-muted-foreground");
  });
  it("lets the later of two roles, and of two paddings, win", () => {
    expect(cn("text-body", "text-caption")).toBe("text-caption");
    expect(cn("p-2", "p-4")).toBe("p-4");
  });
});

describe("the phone's split view", () => {
  const view = (open: boolean, onBack = vi.fn()) => render(<SplitView listLabel="Tasks" open={open} onBack={onBack} list="the list" detail="the detail" />);
  it("shows the list until a record is open", () => {
    const { container } = view(false);
    expect(container.querySelector('[data-kit="split-view"]')?.getAttribute("data-pane")).toBe("list");
    expect(screen.getByLabelText("Detail").className).toContain("max-md:hidden");
  });
  it("shows the detail with a way back", () => {
    const back = vi.fn();
    view(true, back);
    expect(screen.getByLabelText("Tasks").className).toContain("max-md:hidden");
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(back).toHaveBeenCalled();
  });
});

describe("a 401 mid-session", () => {
  const ada = { id: 1, name: "Ada Admin", email: "ada@example.com", role: "admin", kind: "human", status: "active", is_demo: false };
  const respond = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));
  let fetchMock: ReturnType<typeof vi.fn>;
  const Page = () => { const { me } = useSession(); return <p>{me ? `Working as ${me.name}` : "Signed out"}</p>; };
  const app = async () => {
    render(<MemoryRouter><TooltipProvider><SessionProvider><Page /><SessionDialog /></SessionProvider></TooltipProvider></MemoryRouter>);
    await screen.findByText("Working as Ada Admin");
  };

  beforeEach(() => {
    localStorage.clear(); sessionStorage.clear();
    token.set("old");
    fetchMock = vi.fn((url: string) => (url.includes("auth/me") ? respond(200, ada) : respond(401, { message: "No" })));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("leaves the screen where it is and asks for a sign-in", async () => {
    await app();
    await act(() => request("GET", "/anything").catch(() => {}));
    expect(screen.getByText("Working as Ada Admin")).toBeTruthy();
    expect(screen.getByText("Sign in to keep working")).toBeTruthy();
    expect(screen.getByText(/Your drafts are safe/)).toBeTruthy();
  });

  it("can't be dismissed with Escape, and carries on after signing in", async () => {
    await app();
    await act(() => request("GET", "/anything").catch(() => {}));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.getByText("Sign in to keep working")).toBeTruthy();
    fetchMock.mockImplementation((url: string) => (url.includes("auth/login") ? respond(200, { authToken: "new" }) : respond(200, ada)));
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter22" } });
    await act(async () => { fireEvent.submit(document.getElementById("session-form")!); });
    expect(await screen.findByText("Working as Ada Admin")).toBeTruthy();
    expect(screen.queryByText("Sign in to keep working")).toBeNull();
    expect(token.get()).toBe("new");
  });
});

describe("opening the app when the server can't be reached", () => {
  const ada = { id: 1, name: "Ada Admin", email: "ada@example.com", role: "admin", kind: "human", status: "active", is_demo: false };
  const Page = () => { const { me } = useSession(); return <p>{me ? `Working as ${me.name}` : "Signed out"}</p>; };
  const open = () => render(<MemoryRouter><TooltipProvider><SessionProvider><Page /></SessionProvider></TooltipProvider></MemoryRouter>);

  beforeEach(() => { localStorage.clear(); sessionStorage.clear(); token.set("kept"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("keeps the sign-in through a dropped connection, and carries on once it's back", async () => {
    const fetchMock = vi.fn((): Promise<Response> => Promise.reject(new TypeError("Failed to fetch")));
    vi.stubGlobal("fetch", fetchMock);
    open();
    expect(await screen.findByText("We can't reach Commons right now")).toBeTruthy();
    expect(token.get()).toBe("kept");
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify(ada), { status: 200 })));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Try again" })); });
    expect(await screen.findByText("Working as Ada Admin")).toBeTruthy();
  });

  it("keeps the sign-in when the server has a problem", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("{}", { status: 503 }))));
    open();
    expect(await screen.findByText("We can't reach Commons right now")).toBeTruthy();
    expect(token.get()).toBe("kept");
  });

  it("still signs out a token the server refuses", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ message: "No" }), { status: 401 }))));
    open();
    expect(await screen.findByText("Signed out")).toBeTruthy();
    expect(token.get()).toBeNull();
  });
});

describe("a short date", () => {
  it("reads the same with or without its year: no comma either way", () => {
    const next = new Date().getFullYear() + 1;
    expect(shortDate(new Date(next, 0, 8))).not.toContain(",");
    expect(shortDate(new Date(next, 0, 8))).toContain(String(next));
    expect(shortDate(new Date(new Date().getFullYear(), 10, 21))).not.toContain(",");
  });
});
