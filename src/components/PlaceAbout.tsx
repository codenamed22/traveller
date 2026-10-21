import { aboutLabels, aboutLines, type StopAbout } from "@/lib/trip";

// What a guide says about a place: what it is, what to expect and what to do there.
export function PlaceAbout({ about }: { about?: StopAbout }) {
  const lines = aboutLines(about);
  if (!lines.length) return null;
  return <dl className="place-about">{lines.map((line) => <div key={line.key}><dt>{line.label}</dt><dd>{line.text}</dd></div>)}</dl>;
}

// The same three lines to edit, under the place's own settings.
export function PlaceAboutFields({ about, onChange }: { about?: StopAbout; onChange: (about: StopAbout | undefined) => void }) {
  const current = about ?? { what: "", expect: "", todo: "" };
  const change = (key: keyof StopAbout, text: string) => {
    const next = { ...current, [key]: text };
    onChange(Object.values(next).some((value) => value.trim()) ? next : undefined);
  };
  return <details className="place-about-fields" open={Boolean(about)}>
    <summary>About this place</summary>
    {(Object.keys(aboutLabels) as (keyof StopAbout)[]).map((key) => <label className="field" key={key}>{aboutLabels[key]}<textarea rows={2} maxLength={300} value={current[key]} onChange={(event) => change(key, event.target.value)} /></label>)}
  </details>;
}
