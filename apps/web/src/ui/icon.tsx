// One icon set for the whole app: Phosphor Icons (MIT), "fill" weight, pinned in package.json. The one
// exception is the thin check (`weight="regular"`), which replaces a typed "✓" wherever a tick is an
// icon. Icons are decorative (aria-hidden): every control that uses one also has a text label.
import {
  ArrowDown,
  ArrowRight,
  Buildings,
  CalendarCheck,
  Check,
  CheckCircle,
  Clock,
  Copy,
  DownloadSimple,
  FileText,
  GearSix,
  GithubLogo,
  Globe,
  House,
  Lightning,
  DotsThreeOutline,
  List,
  LockSimple,
  Moon,
  Plus,
  Receipt,
  Robot,
  ShieldCheck,
  SignOut,
  Sun,
  UserCircle,
  Users,
  Wallet,
  Warning,
  X,
  XCircle,
  XLogo,
} from "@phosphor-icons/react/dist/ssr";

const ICONS = {
  arrowDown: ArrowDown,
  arrowRight: ArrowRight,
  buildings: Buildings,
  calendar: CalendarCheck,
  check: Check,
  checkCircle: CheckCircle,
  clock: Clock,
  copy: Copy,
  download: DownloadSimple,
  file: FileText,
  gear: GearSix,
  dots: DotsThreeOutline,
  github: GithubLogo,
  globe: Globe,
  home: House,
  lightning: Lightning,
  menu: List,
  lock: LockSimple,
  moon: Moon,
  plus: Plus,
  receipt: Receipt,
  robot: Robot,
  shield: ShieldCheck,
  signOut: SignOut,
  sun: Sun,
  user: UserCircle,
  users: Users,
  wallet: Wallet,
  warning: Warning,
  close: X,
  xCircle: XCircle,
  xLogo: XLogo,
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 20,
  weight = "fill",
}: {
  name: IconName;
  size?: number;
  weight?: "fill" | "regular";
}) {
  const Glyph = ICONS[name];
  return <Glyph size={size} weight={weight} aria-hidden="true" focusable="false" />;
}

/**
 * The thin success tick (Phosphor Check, regular weight). It is sized to the text around it
 * (1.1em, so it follows the font-size), takes the colour of the text (`currentColor`), and sits on the
 * text's middle line. It replaces a typed "✓" anywhere a tick is an icon.
 */
export function CheckMark() {
  const Glyph = ICONS.check;
  return <Glyph className="tick" weight="regular" aria-hidden="true" focusable="false" />;
}
