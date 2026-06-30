import { Redirect } from "expo-router";
import { useHostRouteServerId } from "@/navigation/host-route-context";
import { HermesRoomScreen } from "@/screens/hermes-room-screen";
import { buildOpenProjectRoute } from "@/utils/host-routes";

export default function HermesRoute() {
  const serverId = useHostRouteServerId();
  if (!serverId) {
    return <Redirect href={buildOpenProjectRoute()} />;
  }
  return <HermesRoomScreen serverId={serverId} />;
}
