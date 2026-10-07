import type { Metadata } from "next";
import { TasksPageClient } from "@/features/tasks/tasks-page-client";

export const metadata: Metadata = {
  title: "Tasks",
};

export default function TasksPage() {
  return <TasksPageClient />;
}
