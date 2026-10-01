import { Card, CardContent } from '@/renderer/components/ui/card';
import { UpdatePanel } from '@/renderer/components/update-panel';

/** Settings card wrapper around the shared update panel. */
export function UpdateSettings() {
  return (
    <Card>
      <CardContent>
        <UpdatePanel />
      </CardContent>
    </Card>
  );
}
