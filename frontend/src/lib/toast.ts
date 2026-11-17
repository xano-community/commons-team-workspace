// Toasts from the shell. sonner stays out of the first paint: nothing toasts before someone does something, so the shell
// loads it after it has painted, and the screens, which are lazy anyway, import it directly.
type Action = { label: string; onClick: () => void };

const sonner = () => import("sonner");

export const shellToast = {
  error: (message: string) => void sonner().then((s) => s.toast.error(message)),
  show: (message: string, action?: Action) => void sonner().then((s) => s.toast(message, action ? { action } : undefined)),
};
