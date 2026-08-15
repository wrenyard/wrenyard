export type PmTicketStatus = 'todo' | 'in_progress' | 'done' | 'blocked'
export type PmTicketKind = 'main' | 'sub'

export interface PmTicketAssignee {
  session_id: string
}

export interface PmTicket {
  id: string
  kind: PmTicketKind
  project_id: string
  title: string
  description?: string
  status: PmTicketStatus
  parent_id?: string
  assignee?: PmTicketAssignee
  created_at: string
  updated_at: string
}

export interface PmTicketCreateInput {
  kind: PmTicketKind
  project_id: string
  title: string
  description?: string
  parent_id?: string
  assignee?: PmTicketAssignee
}

export interface PmTicketGetInput {
  id: string
}

export interface PmTicketListInput {
  project_id: string
  kind?: PmTicketKind
  status?: PmTicketStatus
  parent_id?: string
  assignee_session_id?: string
}

export interface PmTicketUpdateEditInput {
  action: 'edit'
  id: string
  title?: string
  description?: string | null
  assignee?: PmTicketAssignee | null
}

export interface PmTicketUpdateSetStatusInput {
  action: 'set_status'
  id: string
  status: PmTicketStatus
}

export type PmTicketUpdateInput = PmTicketUpdateEditInput | PmTicketUpdateSetStatusInput

export interface PmTicketDeleteInput {
  id: string
}
