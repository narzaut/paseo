import { Bot } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { definePanel, type PanelPresentation } from "@/panels/panel-registry";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import { HermesRoomContent } from "@/screens/hermes-room-screen";

const ThemedBot = withUnistyles(Bot);

const hermesRoomPanelPresentation = {
  label: () => "Hermes",
  subtitle: () => "Room",
  tooltip: () => "Hermes room",
  icon: ThemedBot,
} satisfies PanelPresentation;

function HermesRoomPanel() {
  const { serverId } = usePaneContext();
  const { isInteractive } = usePaneFocus();
  return <HermesRoomContent serverId={serverId} isFocused={isInteractive} />;
}

export const hermesRoomPanelRegistration = definePanel("hermes_room", {
  component: HermesRoomPanel,
  presentation: hermesRoomPanelPresentation,
});
