import { Switch as SwitchPrimitive } from "@base-ui/react/switch"
import { cn } from "cn"

function Switch({
  className,
  size = "default",
  ...props
}: SwitchPrimitive.Root.Props & {
  size?: "sm" | "default"
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        // M3 Expressive track: a pill with a 2px border. The default track is
        // 24x44px (inner 20x40px) so the 16px thumb parks 4px from either end;
        // the small track is 20x36px (inner 16x32px) for a 12px thumb.
        "peer group/switch relative inline-flex shrink-0 items-center rounded-full border-2 transition-colors duration-base ease-[var(--ease-m3-spring-fast)] outline-none group-has-[:focus-visible]/field-label:ring-0 after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-[size=default]:h-6 data-[size=default]:w-11 data-[size=sm]:h-5 data-[size=sm]:w-9 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 data-checked:border-primary data-checked:bg-primary group-has-[:focus-visible]/field-label:data-checked:border-primary data-unchecked:border-border data-unchecked:bg-surface-container-highest data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          // The thumb morphs from a shrunken muted dot (unchecked) to a full
          // primary-foreground dot (checked) and widens while pressed.
          "pointer-events-none block rounded-full shadow-sm ring-0 transition-[transform,width,background-color] duration-base ease-[var(--ease-m3-spring-fast)] group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3 group-data-[size=default]/switch:group-active/switch:w-5 data-checked:translate-x-[22px] data-checked:scale-100 data-checked:bg-primary-foreground data-unchecked:translate-x-0.5 data-unchecked:scale-75 data-unchecked:bg-muted-foreground group-data-[size=sm]/switch:data-checked:translate-x-[18px]"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
