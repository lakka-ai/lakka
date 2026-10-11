/*
 * A model as an option in a list (the chat picker, the model select): its name, then its id in
 * mono, as the Models table writes it, each on one line and cut with an ellipsis when it does not
 * fit. Two models can share a name, from two providers; the id tells them apart.
 */
export function ModelOptionText({ name, id }: { name: string; id: string }) {
  return (
    <span className="flex min-w-0 grow flex-col leading-tight">
      <span className="truncate">{name}</span>
      <span className="truncate font-mono text-caption text-muted">{id}</span>
    </span>
  );
}
