import { z } from "zod";
import { createErrorResponse, createSuccessResponse, parseJsonBody } from "@/app/api/meta/_lib/route-utils";
import { getSupabaseAdminClient } from "@/lib/server/supabase-admin";
import { resolveTenantRequestContext } from "@/lib/server/tenant-context";

const createSchema = z.object({ projectName: z.string().trim().min(1).max(120) }).strict();
export async function GET() {
  try { const context = await resolveTenantRequestContext(); const { data, error } = await getSupabaseAdminClient().from("projects").select("id,project_name,is_active,meta_ad_project_mappings(count)").eq("tenant_id", context.tenantId).order("is_active", { ascending: false }).order("project_name"); if (error) throw error; return createSuccessResponse((data ?? []).map((project) => ({ id: project.id, name: project.project_name, isActive: project.is_active, mappedAdCount: Array.isArray(project.meta_ad_project_mappings) ? project.meta_ad_project_mappings.length : 0 }))); } catch (error) { return createErrorResponse(error); }
}
export async function POST(request: Request) {
  try { const context = await resolveTenantRequestContext(); const body = await parseJsonBody(request, createSchema); const { data, error } = await getSupabaseAdminClient().from("projects").insert({ tenant_id: context.tenantId, project_name: body.projectName }).select("id,project_name,is_active").single(); if (error) throw error; return createSuccessResponse({ id: data.id, name: data.project_name, isActive: data.is_active, mappedAdCount: 0 }, 201); } catch (error) { return createErrorResponse(error); }
}
