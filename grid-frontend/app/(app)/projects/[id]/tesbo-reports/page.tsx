import { redirect } from "next/navigation";

export default async function TesboReportsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/projects/${id}/tesbo-reports/runs`);
}
