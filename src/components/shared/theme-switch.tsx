import { setThemeAction } from '@/actions/theme.actions';

/**
 * A switch between light and dark.
 *
 * Two buttons, only ever one of them visible: "go dark" while the screen is
 * light, "go light" while it is dark. CSS decides which — see `.theme-when-*`
 * in globals.css.
 *
 * That indirection is what makes a genuine toggle possible alongside "match my
 * device". Under that setting the server has no idea which scheme the device is
 * actually showing, so it cannot know which way the switch should point; the
 * browser does know, so the decision is made there. No JavaScript either way.
 *
 * NOTE: there is no control to return to "match my device" once a choice has
 * been made. Following the device remains the default for anyone who has not
 * touched the switch; getting back to it means clearing the cookie.
 */
export function ThemeSwitch() {
  const track =
    'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors';
  const knob =
    'absolute h-4.5 w-4.5 rounded-full bg-surface-raised shadow-sm transition-transform';

  return (
    <div className="flex items-center gap-2">
      {/* Shown while the screen is light: pressing it goes dark. */}
      <form action={setThemeAction} className="theme-when-light inline-flex">
        <input type="hidden" name="theme" value="dark" />
        <button
          type="submit"
          role="switch"
          aria-checked="false"
          aria-label="Dark mode"
          title="Switch to dark"
          className={`${track} border-line-strong bg-surface-sunken`}
        >
          <span className={`${knob} left-0.5`} />
        </button>
      </form>

      {/* Shown while the screen is dark: pressing it goes light. */}
      <form action={setThemeAction} className="theme-when-dark">
        <input type="hidden" name="theme" value="light" />
        <button
          type="submit"
          role="switch"
          aria-checked="true"
          aria-label="Dark mode"
          title="Switch to light"
          className={`${track} border-accent bg-accent`}
        >
          <span className={`${knob} right-0.5`} />
        </button>
      </form>

    </div>
  );
}
