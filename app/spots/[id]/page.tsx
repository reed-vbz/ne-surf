import SpotView from "@/components/spots/SpotView";
import { SPOTS, spotById } from "@/lib/spots";

export const dynamicParams = false;
export function generateStaticParams() { return SPOTS.map((s) => ({ id: s.id })); }
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params; const s = spotById(id);
  return { title: s ? `${s.name} surf forecast — NE Surf` : "NE Surf" };
}

export default async function SpotPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SpotView id={id} />;
}
