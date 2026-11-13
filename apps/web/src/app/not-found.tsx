import "../styles/app.css";
import { ButtonLink, Logo } from "../ui/basic";

export default function NotFound() {
  return (
    <main className="signin" id="main">
      <div className="card card-lg stack">
        <Logo />
        <h1>Page not found</h1>
        <p className="muted">That page doesn&apos;t exist.</p>
        <ButtonLink href="/">Back to Veylo</ButtonLink>
      </div>
    </main>
  );
}
