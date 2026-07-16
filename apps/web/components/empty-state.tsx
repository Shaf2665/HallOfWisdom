export function EmptyState({ message }: { readonly message: string }) {
  return <p className="text-sm text-stone-500 dark:text-stone-400">{message}</p>;
}
