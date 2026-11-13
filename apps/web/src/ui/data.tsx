// CheckList, Table and Picture.
import type { ReactNode } from "react";
import { IMAGE_FORMATS, IMAGES, imagePath, imageSize, type ImageKey } from "../design/images";
import { Icon } from "./icon";

/** A 1×1 transparent GIF: what small screens "load" instead of a photo they don't show. */
const BLANK = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

export type CheckState = "pass" | "fail" | "pending";

export type CheckItem = { id: string; label: string; state: CheckState; reason?: string };

const STATE_TEXT: Record<CheckState, string> = { pass: "PASS", fail: "FAIL", pending: "PENDING" };

/** The browser gates, as a list. State is shown in text as well as colour. */
export function CheckList({ items, label }: { items: readonly CheckItem[]; label: string }) {
  return (
    <ul className="checklist" aria-label={label}>
      {items.map((c) => (
        <li key={c.id} className={`check-${c.state}`}>
          <span className="check-icon" aria-hidden="true">
            <Icon
              name={c.state === "pass" ? "check" : c.state === "fail" ? "close" : "clock"}
              size={16}
            />
          </span>
          <span>
            {c.label}
            {c.reason && c.state !== "pass" ? <span className="reason">{c.reason}</span> : null}
          </span>
          <span className="check-state">{STATE_TEXT[c.state]}</span>
        </li>
      ))}
    </ul>
  );
}

export type Column<Row> = {
  key: string;
  label: string;
  render: (row: Row) => ReactNode;
  align?: "right";
};

/** A table that becomes labelled cards on narrow screens. */
export function Table<Row>({
  caption,
  columns,
  rows,
  rowKey,
}: {
  caption: string;
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
}) {
  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={c.align === "right" ? "right" : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)}>
              {columns.map((c) => (
                <td
                  key={c.key}
                  data-label={c.label}
                  className={c.align === "right" ? "right" : undefined}
                >
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A responsive photo: AVIF, then WebP, then JPEG, with intrinsic width and height so nothing shifts.
 * `alt` is required: pass "" only for a decorative image.
 */
export function Picture({
  image,
  alt,
  sizes,
  className,
  priority = false,
  minWidth,
}: {
  image: ImageKey;
  alt: string;
  sizes: string;
  className?: string;
  priority?: boolean;
  /** Below this viewport width the photo isn't downloaded at all (a 1×1 transparent stand-in). */
  minWidth?: number;
}) {
  const spec = IMAGES[image];
  const { width, height } = imageSize(image);
  const srcset = (format: string) =>
    spec.widths.map((w) => `${imagePath(image, w, format)} ${w}w`).join(", ");
  const fallback = spec.widths[spec.widths.length - 1] ?? width;
  return (
    <picture className={className}>
      {minWidth ? <source media={`(max-width: ${minWidth - 1}px)`} srcSet={BLANK} /> : null}
      {IMAGE_FORMATS.filter((f) => f !== "jpg").map((f) => (
        <source key={f} type={`image/${f}`} srcSet={srcset(f)} sizes={sizes} />
      ))}
      <img
        src={imagePath(image, fallback, "jpg")}
        srcSet={srcset("jpg")}
        sizes={sizes}
        width={width}
        height={height}
        alt={alt}
        loading={priority ? "eager" : "lazy"}
        decoding={priority ? "auto" : "async"}
        fetchPriority={priority ? "high" : "auto"}
      />
    </picture>
  );
}
