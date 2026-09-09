import { useRef } from "react";

export function CodeEditor({
  label,
  value,
  readOnly,
  onChange,
}: {
  label: string;
  value: string;
  readOnly: boolean;
  onChange(value: string): void;
}) {
  const gutter = useRef<HTMLDivElement>(null);
  const lineNumbers = Array.from(
    { length: value.split("\n").length },
    (_line, index) => index + 1,
  ).join("\n");
  return (
    <div className="code-editor">
      <div className="line-numbers" ref={gutter} aria-hidden="true">
        {lineNumbers}
      </div>
      <textarea
        aria-label={label}
        spellCheck={false}
        value={value}
        readOnly={readOnly}
        onChange={(event) => onChange(event.target.value)}
        onScroll={(event) => {
          if (gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop;
        }}
      />
    </div>
  );
}
