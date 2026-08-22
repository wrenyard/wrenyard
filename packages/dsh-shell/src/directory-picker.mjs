/**
 * Host-only directoryPicker stub. DSH's API gateway injects `directoryPicker`;
 * disabling the auto picker without a replacement leaves apiproxy pending.
 * An unknown capability kind hides “添加工作区” instead of opening a chooser.
 */
import { DirectoryPicker } from '@deepseek-ai/dsh-host-directory-picker';

const PINNED = Object.freeze({ kind: 'pinned' });

export default class PinnedDirectoryPicker extends DirectoryPicker {
  capability() {
    return PINNED;
  }
}
