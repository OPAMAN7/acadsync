export type Priority = 'high' | 'medium' | 'low';
export type Status = 'todo' | 'in_progress' | 'completed';
export type Source = 'manual' | 'classroom';

export interface Task {
  id: string;
  userId: string;
  title: string;
  description?: string;
  dueDate: string | null;
  priority: Priority;
  status: Status;
  source: Source;
  courseName?: string;
  externalId?: string;
  link?: string;
}

export interface TimetableEntry {
  id: string;
  userId: string;
  courseName: string;
  dayOfWeek: 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';
  startTime: string;
  endTime: string;
  room?: string;
}

export interface UserSettings {
  email: string;
  telegramToken?: string;
  telegramChatId?: string;
  oauthConnected: boolean;
  googleTokens?: any;
}
