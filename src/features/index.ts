import { branchStatusBar } from './branchStatusBar';
import { changedFilesBadge } from './changedFilesBadge';
import { statusMenu } from './statusMenu';
import { Feature } from './types';

// Add new features here; each needs an `ohmg.<enabledSetting>` entry in package.json.
export const features: Feature[] = [branchStatusBar, changedFilesBadge, statusMenu];
