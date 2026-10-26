// Requests to open a folder from outside the app (Explorer menu, command line, a second launch). The
// backend validates them and keeps them until taken; `app:open-request` only says one is waiting. Each one
// pins its folder and starts a session there in a tab.

import type { OpenRequest } from "../../bindings/OpenRequest";
import { call, listen } from "../../core/api";
import { emit } from "../../core/bus";
import { samePath } from "../../core/paths";
import { settings, updateSettings } from "../../core/settings";
import { store } from "../../core/store";
import { isMainWindow } from "../../core/window";
import { refreshIndex } from "../index-data/api";

/** Adds `dir` to the pinned folders unless it is there already. */
export async function pin(dir: string): Promise<void> {
  const { os } = store.get().platform;
  const pinned = settings().pinned;
  if (pinned.some((p) => samePath(p, dir, os))) return;
  if (await updateSettings({ pinned: [...pinned, dir] })) void refreshIndex();
}

export async function handleOpenRequest(req: OpenRequest): Promise<void> {
  await pin(req.dir);
  emit("launch", { dir: req.dir, profile: req.profile ?? undefined, mode: "embed" });
}

async function takeOpenRequests(): Promise<void> {
  const res = await call("take_open_request", undefined, { quiet: true });
  if (!res.ok) return;
  for (const req of res.value) await handleOpenRequest(req);
}

export async function installOpenRequests(): Promise<void> {
  if (!isMainWindow()) return;
  await listen("app:open-request", () => void takeOpenRequests());
  // requests made before the page listened (a first launch from the Explorer menu)
  await takeOpenRequests();
}
