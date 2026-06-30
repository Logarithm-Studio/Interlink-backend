/**
 * Google Tasks API service.
 * Reuses the existing Google OAuth tokens from connected_accounts.
 * Requires 'https://www.googleapis.com/auth/tasks' scope added to Google OAuth.
 */

import { google } from "googleapis";
import { refreshGoogleTokenIfNeeded } from "../auth.service";

async function getTasksClient(userId: string) {
  const accessToken = await refreshGoogleTokenIfNeeded(userId);
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.tasks({ version: "v1", auth });
}

export interface TaskList {
  id: string;
  title: string;
  updated: string;
}

export interface Task {
  id: string;
  title: string;
  notes: string | null;
  due: string | null;
  status: "needsAction" | "completed";
  listId: string;
  updated: string;
}

export async function getTaskLists(userId: string): Promise<TaskList[]> {
  const tasks = await getTasksClient(userId);
  const res = await tasks.tasklists.list({ maxResults: 20 });
  return (res.data.items ?? []).map((tl) => ({
    id: tl.id!,
    title: tl.title ?? "Untitled",
    updated: tl.updated ?? new Date().toISOString(),
  }));
}

export async function getTasksInList(
  userId: string,
  taskListId: string,
  opts?: { showCompleted?: boolean },
): Promise<Task[]> {
  const client = await getTasksClient(userId);
  const res = await client.tasks.list({
    tasklist: taskListId,
    showCompleted: opts?.showCompleted ?? false,
    maxResults: 100,
  });
  return (res.data.items ?? [])
    .filter((t) => t.id)
    .map((t) => ({
      id: t.id!,
      title: t.title ?? "",
      notes: t.notes ?? null,
      due: t.due ?? null,
      status: (t.status ?? "needsAction") as "needsAction" | "completed",
      listId: taskListId,
      updated: t.updated ?? new Date().toISOString(),
    }));
}

export async function createTask(
  userId: string,
  taskListId: string,
  data: { title: string; notes?: string; due?: string },
): Promise<Task> {
  const client = await getTasksClient(userId);
  const res = await client.tasks.insert({
    tasklist: taskListId,
    requestBody: { title: data.title, notes: data.notes, due: data.due },
  });
  return {
    id: res.data.id!,
    title: res.data.title ?? "",
    notes: res.data.notes ?? null,
    due: res.data.due ?? null,
    status: (res.data.status ?? "needsAction") as "needsAction" | "completed",
    listId: taskListId,
    updated: res.data.updated ?? new Date().toISOString(),
  };
}

export async function updateTask(
  userId: string,
  taskListId: string,
  taskId: string,
  patch: { title?: string; notes?: string; due?: string; status?: "needsAction" | "completed" },
): Promise<Task> {
  const client = await getTasksClient(userId);
  const res = await client.tasks.patch({
    tasklist: taskListId,
    task: taskId,
    requestBody: patch,
  });
  return {
    id: res.data.id!,
    title: res.data.title ?? "",
    notes: res.data.notes ?? null,
    due: res.data.due ?? null,
    status: (res.data.status ?? "needsAction") as "needsAction" | "completed",
    listId: taskListId,
    updated: res.data.updated ?? new Date().toISOString(),
  };
}

export async function deleteTask(userId: string, taskListId: string, taskId: string): Promise<void> {
  const client = await getTasksClient(userId);
  await client.tasks.delete({ tasklist: taskListId, task: taskId });
}

export async function completeTask(userId: string, taskListId: string, taskId: string): Promise<Task> {
  return updateTask(userId, taskListId, taskId, { status: "completed" });
}
