export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      agent_feedback: {
        Row: {
          agent_run_id: string
          corrected_output: Json | null
          created_at: string
          feedback_type: string
          id: string
          note: string | null
          original_output: Json | null
          provided_by: string | null
        }
        Insert: {
          agent_run_id: string
          corrected_output?: Json | null
          created_at?: string
          feedback_type: string
          id?: string
          note?: string | null
          original_output?: Json | null
          provided_by?: string | null
        }
        Update: {
          agent_run_id?: string
          corrected_output?: Json | null
          created_at?: string
          feedback_type?: string
          id?: string
          note?: string | null
          original_output?: Json | null
          provided_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_feedback_agent_run_id_fkey"
            columns: ["agent_run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agent_feedback_provided_by_fkey"
            columns: ["provided_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_runs: {
        Row: {
          agent_name: string
          confidence_score: number | null
          duration_ms: number | null
          ended_at: string | null
          error_message: string | null
          id: string
          input_summary: string | null
          llm_cost_usd: number | null
          llm_input_tokens: number | null
          llm_model: string | null
          llm_output_tokens: number | null
          metadata: Json
          output_summary: string | null
          started_at: string
          status: string
          trigger_metadata: Json | null
          trigger_type: string
        }
        Insert: {
          agent_name: string
          confidence_score?: number | null
          duration_ms?: number | null
          ended_at?: string | null
          error_message?: string | null
          id?: string
          input_summary?: string | null
          llm_cost_usd?: number | null
          llm_input_tokens?: number | null
          llm_model?: string | null
          llm_output_tokens?: number | null
          metadata?: Json
          output_summary?: string | null
          started_at?: string
          status: string
          trigger_metadata?: Json | null
          trigger_type: string
        }
        Update: {
          agent_name?: string
          confidence_score?: number | null
          duration_ms?: number | null
          ended_at?: string | null
          error_message?: string | null
          id?: string
          input_summary?: string | null
          llm_cost_usd?: number | null
          llm_input_tokens?: number | null
          llm_model?: string | null
          llm_output_tokens?: number | null
          metadata?: Json
          output_summary?: string | null
          started_at?: string
          status?: string
          trigger_metadata?: Json | null
          trigger_type?: string
        }
        Relationships: []
      }
      alerts: {
        Row: {
          acknowledged_at: string | null
          alert_type: string
          client_id: string | null
          context: Json | null
          created_at: string
          created_by_run_id: string | null
          description: string
          id: string
          resolved_at: string | null
          severity: string
          status: string
          team_member_id: string | null
          title: string
        }
        Insert: {
          acknowledged_at?: string | null
          alert_type: string
          client_id?: string | null
          context?: Json | null
          created_at?: string
          created_by_run_id?: string | null
          description: string
          id?: string
          resolved_at?: string | null
          severity: string
          status?: string
          team_member_id?: string | null
          title: string
        }
        Update: {
          acknowledged_at?: string | null
          alert_type?: string
          client_id?: string | null
          context?: Json | null
          created_at?: string
          created_by_run_id?: string | null
          description?: string
          id?: string
          resolved_at?: string | null
          severity?: string
          status?: string
          team_member_id?: string | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "alerts_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "alerts_created_by_run_id_fkey"
            columns: ["created_by_run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "alerts_team_member_id_fkey"
            columns: ["team_member_id"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
        ]
      }
      call_action_items: {
        Row: {
          call_id: string
          completed_at: string | null
          description: string
          due_date: string | null
          extracted_at: string
          id: string
          owner_client_id: string | null
          owner_team_member_id: string | null
          owner_type: string
          status: string
        }
        Insert: {
          call_id: string
          completed_at?: string | null
          description: string
          due_date?: string | null
          extracted_at?: string
          id?: string
          owner_client_id?: string | null
          owner_team_member_id?: string | null
          owner_type?: string
          status?: string
        }
        Update: {
          call_id?: string
          completed_at?: string | null
          description?: string
          due_date?: string | null
          extracted_at?: string
          id?: string
          owner_client_id?: string | null
          owner_team_member_id?: string | null
          owner_type?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_action_items_call_id_fkey"
            columns: ["call_id"]
            isOneToOne: false
            referencedRelation: "calls"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_action_items_owner_client_id_fkey"
            columns: ["owner_client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_action_items_owner_team_member_id_fkey"
            columns: ["owner_team_member_id"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
        ]
      }
      call_classification_history: {
        Row: {
          call_id: string
          changed_at: string
          changed_by: string | null
          field_name: string
          id: string
          new_value: string | null
          old_value: string | null
        }
        Insert: {
          call_id: string
          changed_at?: string
          changed_by?: string | null
          field_name: string
          id?: string
          new_value?: string | null
          old_value?: string | null
        }
        Update: {
          call_id?: string
          changed_at?: string
          changed_by?: string | null
          field_name?: string
          id?: string
          new_value?: string | null
          old_value?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "call_classification_history_call_id_fkey"
            columns: ["call_id"]
            isOneToOne: false
            referencedRelation: "calls"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_classification_history_changed_by_fkey"
            columns: ["changed_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
        ]
      }
      call_participants: {
        Row: {
          call_id: string
          client_id: string | null
          display_name: string | null
          email: string
          id: string
          participant_role: string | null
          team_member_id: string | null
        }
        Insert: {
          call_id: string
          client_id?: string | null
          display_name?: string | null
          email: string
          id?: string
          participant_role?: string | null
          team_member_id?: string | null
        }
        Update: {
          call_id?: string
          client_id?: string | null
          display_name?: string | null
          email?: string
          id?: string
          participant_role?: string | null
          team_member_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "call_participants_call_id_fkey"
            columns: ["call_id"]
            isOneToOne: false
            referencedRelation: "calls"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_participants_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_participants_team_member_id_fkey"
            columns: ["team_member_id"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
        ]
      }
      calls: {
        Row: {
          call_category: string
          call_type: string | null
          classification_confidence: number | null
          classification_method: string | null
          duration_seconds: number | null
          external_id: string
          id: string
          ingested_at: string
          is_retrievable_by_client_agents: boolean
          primary_client_id: string | null
          raw_payload: Json
          recording_url: string | null
          source: string
          started_at: string
          summary: string | null
          title: string | null
          transcript: string | null
        }
        Insert: {
          call_category: string
          call_type?: string | null
          classification_confidence?: number | null
          classification_method?: string | null
          duration_seconds?: number | null
          external_id: string
          id?: string
          ingested_at?: string
          is_retrievable_by_client_agents?: boolean
          primary_client_id?: string | null
          raw_payload: Json
          recording_url?: string | null
          source?: string
          started_at: string
          summary?: string | null
          title?: string | null
          transcript?: string | null
        }
        Update: {
          call_category?: string
          call_type?: string | null
          classification_confidence?: number | null
          classification_method?: string | null
          duration_seconds?: number | null
          external_id?: string
          id?: string
          ingested_at?: string
          is_retrievable_by_client_agents?: boolean
          primary_client_id?: string | null
          raw_payload?: Json
          recording_url?: string | null
          source?: string
          started_at?: string
          summary?: string | null
          title?: string | null
          transcript?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "calls_primary_client_id_fkey"
            columns: ["primary_client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      client_health_scores: {
        Row: {
          client_id: string
          computed_at: string
          computed_by_run_id: string | null
          factors: Json
          id: string
          score: number
          tier: string
        }
        Insert: {
          client_id: string
          computed_at?: string
          computed_by_run_id?: string | null
          factors: Json
          id?: string
          score: number
          tier: string
        }
        Update: {
          client_id?: string
          computed_at?: string
          computed_by_run_id?: string | null
          factors?: Json
          id?: string
          score?: number
          tier?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_health_scores_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_health_scores_computed_by_run_id_fkey"
            columns: ["computed_by_run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      client_journey_stage_history: {
        Row: {
          changed_at: string
          changed_by: string | null
          client_id: string
          id: string
          journey_stage: string | null
          note: string | null
        }
        Insert: {
          changed_at?: string
          changed_by?: string | null
          client_id: string
          id?: string
          journey_stage?: string | null
          note?: string | null
        }
        Update: {
          changed_at?: string
          changed_by?: string | null
          client_id?: string
          id?: string
          journey_stage?: string | null
          note?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_journey_stage_history_changed_by_fkey"
            columns: ["changed_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_journey_stage_history_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      client_standing_history: {
        Row: {
          changed_at: string
          changed_by: string | null
          client_id: string
          csm_standing: string
          id: string
          note: string | null
        }
        Insert: {
          changed_at?: string
          changed_by?: string | null
          client_id: string
          csm_standing: string
          id?: string
          note?: string | null
        }
        Update: {
          changed_at?: string
          changed_by?: string | null
          client_id?: string
          csm_standing?: string
          id?: string
          note?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_standing_history_changed_by_fkey"
            columns: ["changed_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_standing_history_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      client_status_history: {
        Row: {
          changed_at: string
          changed_by: string | null
          client_id: string
          id: string
          note: string | null
          status: string
        }
        Insert: {
          changed_at?: string
          changed_by?: string | null
          client_id: string
          id?: string
          note?: string | null
          status: string
        }
        Update: {
          changed_at?: string
          changed_by?: string | null
          client_id?: string
          id?: string
          note?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_status_history_changed_by_fkey"
            columns: ["changed_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_status_history_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      client_team_assignments: {
        Row: {
          assigned_at: string
          client_id: string
          id: string
          metadata: Json
          role: string
          team_member_id: string
          unassigned_at: string | null
        }
        Insert: {
          assigned_at?: string
          client_id: string
          id?: string
          metadata?: Json
          role: string
          team_member_id: string
          unassigned_at?: string | null
        }
        Update: {
          assigned_at?: string
          client_id?: string
          id?: string
          metadata?: Json
          role?: string
          team_member_id?: string
          unassigned_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_team_assignments_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_team_assignments_team_member_id_fkey"
            columns: ["team_member_id"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
        ]
      }
      client_upsells: {
        Row: {
          amount: number | null
          client_id: string
          created_at: string
          id: string
          notes: string | null
          product: string | null
          recorded_by: string | null
          sold_at: string | null
          updated_at: string
        }
        Insert: {
          amount?: number | null
          client_id: string
          created_at?: string
          id?: string
          notes?: string | null
          product?: string | null
          recorded_by?: string | null
          sold_at?: string | null
          updated_at?: string
        }
        Update: {
          amount?: number | null
          client_id?: string
          created_at?: string
          id?: string
          notes?: string | null
          product?: string | null
          recorded_by?: string | null
          sold_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "client_upsells_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_upsells_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
        ]
      }
      clients: {
        Row: {
          accountability_enabled: boolean
          archetype: string | null
          archived_at: string | null
          arrears: number
          arrears_note: string | null
          birth_year: number | null
          contracted_revenue: number | null
          country: string | null
          created_at: string
          csm_standing: string | null
          dfy_setting: boolean | null
          email: string
          full_name: string
          ghl_adoption: string | null
          id: string
          journey_stage: string | null
          location: string | null
          metadata: Json
          notes: string | null
          nps_enabled: boolean
          nps_standing: string | null
          occupation: string | null
          phone: string | null
          program_type: string | null
          sales_group_candidate: boolean | null
          slack_user_id: string | null
          start_date: string | null
          status: string
          tags: string[]
          timezone: string | null
          trustpilot_status: string | null
          updated_at: string
          upfront_cash_collected: number | null
        }
        Insert: {
          accountability_enabled?: boolean
          archetype?: string | null
          archived_at?: string | null
          arrears?: number
          arrears_note?: string | null
          birth_year?: number | null
          contracted_revenue?: number | null
          country?: string | null
          created_at?: string
          csm_standing?: string | null
          dfy_setting?: boolean | null
          email: string
          full_name: string
          ghl_adoption?: string | null
          id?: string
          journey_stage?: string | null
          location?: string | null
          metadata?: Json
          notes?: string | null
          nps_enabled?: boolean
          nps_standing?: string | null
          occupation?: string | null
          phone?: string | null
          program_type?: string | null
          sales_group_candidate?: boolean | null
          slack_user_id?: string | null
          start_date?: string | null
          status?: string
          tags?: string[]
          timezone?: string | null
          trustpilot_status?: string | null
          updated_at?: string
          upfront_cash_collected?: number | null
        }
        Update: {
          accountability_enabled?: boolean
          archetype?: string | null
          archived_at?: string | null
          arrears?: number
          arrears_note?: string | null
          birth_year?: number | null
          contracted_revenue?: number | null
          country?: string | null
          created_at?: string
          csm_standing?: string | null
          dfy_setting?: boolean | null
          email?: string
          full_name?: string
          ghl_adoption?: string | null
          id?: string
          journey_stage?: string | null
          location?: string | null
          metadata?: Json
          notes?: string | null
          nps_enabled?: boolean
          nps_standing?: string | null
          occupation?: string | null
          phone?: string | null
          program_type?: string | null
          sales_group_candidate?: boolean | null
          slack_user_id?: string | null
          start_date?: string | null
          status?: string
          tags?: string[]
          timezone?: string | null
          trustpilot_status?: string | null
          updated_at?: string
          upfront_cash_collected?: number | null
        }
        Relationships: []
      }
      document_chunks: {
        Row: {
          chunk_index: number
          content: string
          created_at: string
          document_id: string
          embedding: string | null
          id: string
          metadata: Json
          token_count: number | null
        }
        Insert: {
          chunk_index: number
          content: string
          created_at?: string
          document_id: string
          embedding?: string | null
          id?: string
          metadata?: Json
          token_count?: number | null
        }
        Update: {
          chunk_index?: number
          content?: string
          created_at?: string
          document_id?: string
          embedding?: string | null
          id?: string
          metadata?: Json
          token_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "document_chunks_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          archived_at: string | null
          content: string
          created_at: string
          document_type: string
          external_id: string | null
          id: string
          is_active: boolean
          metadata: Json
          source: string
          tags: string[]
          title: string
          updated_at: string
        }
        Insert: {
          archived_at?: string | null
          content: string
          created_at?: string
          document_type: string
          external_id?: string | null
          id?: string
          is_active?: boolean
          metadata?: Json
          source: string
          tags?: string[]
          title: string
          updated_at?: string
        }
        Update: {
          archived_at?: string | null
          content?: string
          created_at?: string
          document_type?: string
          external_id?: string | null
          id?: string
          is_active?: boolean
          metadata?: Json
          source?: string
          tags?: string[]
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      escalations: {
        Row: {
          agent_name: string
          agent_run_id: string
          assigned_to: string | null
          context: Json
          created_at: string
          id: string
          proposed_action: Json | null
          reason: string
          resolution: Json | null
          resolution_note: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: string
        }
        Insert: {
          agent_name: string
          agent_run_id: string
          assigned_to?: string | null
          context: Json
          created_at?: string
          id?: string
          proposed_action?: Json | null
          reason: string
          resolution?: Json | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
        }
        Update: {
          agent_name?: string
          agent_run_id?: string
          assigned_to?: string | null
          context?: Json
          created_at?: string
          id?: string
          proposed_action?: Json | null
          reason?: string
          resolution?: Json | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "escalations_agent_run_id_fkey"
            columns: ["agent_run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "escalations_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "escalations_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
        ]
      }
      nps_submissions: {
        Row: {
          client_id: string
          feedback: string | null
          id: string
          ingested_at: string
          recorded_by: string | null
          score: number
          submitted_at: string
          survey_source: string | null
        }
        Insert: {
          client_id: string
          feedback?: string | null
          id?: string
          ingested_at?: string
          recorded_by?: string | null
          score: number
          submitted_at: string
          survey_source?: string | null
        }
        Update: {
          client_id?: string
          feedback?: string | null
          id?: string
          ingested_at?: string
          recorded_by?: string | null
          score?: number
          submitted_at?: string
          survey_source?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "nps_submissions_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nps_submissions_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
        ]
      }
      pending_ella_responses: {
        Row: {
          agent_run_id: string
          created_at: string
          error_message: string | null
          haiku_decision: string
          haiku_reasoning: string | null
          id: string
          respond_after_ts: string
          responded_at: string | null
          slack_channel_id: string
          status: string
          triggering_message_slack_user_id: string
          triggering_message_ts: string
        }
        Insert: {
          agent_run_id: string
          created_at?: string
          error_message?: string | null
          haiku_decision: string
          haiku_reasoning?: string | null
          id?: string
          respond_after_ts: string
          responded_at?: string | null
          slack_channel_id: string
          status?: string
          triggering_message_slack_user_id: string
          triggering_message_ts: string
        }
        Update: {
          agent_run_id?: string
          created_at?: string
          error_message?: string | null
          haiku_decision?: string
          haiku_reasoning?: string | null
          id?: string
          respond_after_ts?: string
          responded_at?: string | null
          slack_channel_id?: string
          status?: string
          triggering_message_slack_user_id?: string
          triggering_message_ts?: string
        }
        Relationships: [
          {
            foreignKeyName: "pending_ella_responses_agent_run_id_fkey"
            columns: ["agent_run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      oauth_tokens: {
        Row: {
          access_token: string
          access_token_expires_at: string
          created_at: string
          id: string
          provider: string
          refresh_token: string
          scope: string
          team_member_id: string
          updated_at: string
        }
        Insert: {
          access_token: string
          access_token_expires_at: string
          created_at?: string
          id?: string
          provider: string
          refresh_token: string
          scope: string
          team_member_id: string
          updated_at?: string
        }
        Update: {
          access_token?: string
          access_token_expires_at?: string
          created_at?: string
          id?: string
          provider?: string
          refresh_token?: string
          scope?: string
          team_member_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "oauth_tokens_team_member_id_fkey"
            columns: ["team_member_id"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
        ]
      }
      calendar_events: {
        Row: {
          attendees: Json
          calendar_id: string
          created_at: string
          end_time: string
          fetched_at: string
          google_event_id: string
          id: string
          meeting_link: string | null
          raw_payload: Json
          start_time: string
          team_member_id: string
          title: string | null
        }
        Insert: {
          attendees?: Json
          calendar_id: string
          created_at?: string
          end_time: string
          fetched_at?: string
          google_event_id: string
          id?: string
          meeting_link?: string | null
          raw_payload: Json
          start_time: string
          team_member_id: string
          title?: string | null
        }
        Update: {
          attendees?: Json
          calendar_id?: string
          created_at?: string
          end_time?: string
          fetched_at?: string
          google_event_id?: string
          id?: string
          meeting_link?: string | null
          raw_payload?: Json
          start_time?: string
          team_member_id?: string
          title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "calendar_events_team_member_id_fkey"
            columns: ["team_member_id"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
        ]
      }
      director_tasks: {
        Row: {
          created_at: string
          done: boolean
          done_at: string | null
          id: string
          team_member_id: string
          title: string
        }
        Insert: {
          created_at?: string
          done?: boolean
          done_at?: string | null
          id?: string
          team_member_id: string
          title: string
        }
        Update: {
          created_at?: string
          done?: boolean
          done_at?: string | null
          id?: string
          team_member_id?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "director_tasks_team_member_id_fkey"
            columns: ["team_member_id"]
            isOneToOne: false
            referencedRelation: "team_members"
            referencedColumns: ["id"]
          },
        ]
      }
      slack_channels: {
        Row: {
          client_id: string | null
          created_at: string
          passive_monitoring_enabled: boolean
          id: string
          is_archived: boolean
          is_private: boolean
          metadata: Json
          name: string
          slack_channel_id: string
          test_mode: boolean
          updated_at: string
        }
        Insert: {
          client_id?: string | null
          created_at?: string
          passive_monitoring_enabled?: boolean
          id?: string
          is_archived?: boolean
          is_private: boolean
          metadata?: Json
          name: string
          slack_channel_id: string
          test_mode?: boolean
          updated_at?: string
        }
        Update: {
          client_id?: string | null
          created_at?: string
          passive_monitoring_enabled?: boolean
          id?: string
          is_archived?: boolean
          is_private?: boolean
          metadata?: Json
          name?: string
          slack_channel_id?: string
          test_mode?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "slack_channels_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
        ]
      }
      slack_messages: {
        Row: {
          author_type: string
          id: string
          ingested_at: string
          message_subtype: string | null
          message_type: string
          raw_payload: Json
          sent_at: string
          slack_channel_id: string
          slack_thread_ts: string | null
          slack_ts: string
          slack_user_id: string
          text: string
        }
        Insert: {
          author_type: string
          id?: string
          ingested_at?: string
          message_subtype?: string | null
          message_type?: string
          raw_payload: Json
          sent_at: string
          slack_channel_id: string
          slack_thread_ts?: string | null
          slack_ts: string
          slack_user_id: string
          text: string
        }
        Update: {
          author_type?: string
          id?: string
          ingested_at?: string
          message_subtype?: string | null
          message_type?: string
          raw_payload?: Json
          sent_at?: string
          slack_channel_id?: string
          slack_thread_ts?: string | null
          slack_ts?: string
          slack_user_id?: string
          text?: string
        }
        Relationships: []
      }
      team_members: {
        Row: {
          access_tier: string
          archived_at: string | null
          created_at: string
          email: string
          full_name: string
          id: string
          is_active: boolean
          is_csm: boolean
          metadata: Json
          role: string
          slack_user_id: string | null
          updated_at: string
        }
        Insert: {
          access_tier?: string
          archived_at?: string | null
          created_at?: string
          email: string
          full_name: string
          id?: string
          is_active?: boolean
          is_csm?: boolean
          metadata?: Json
          role: string
          slack_user_id?: string | null
          updated_at?: string
        }
        Update: {
          access_tier?: string
          archived_at?: string | null
          created_at?: string
          email?: string
          full_name?: string
          id?: string
          is_active?: boolean
          is_csm?: boolean
          metadata?: Json
          role?: string
          slack_user_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      webhook_deliveries: {
        Row: {
          call_external_id: string | null
          headers: Json | null
          payload: Json | null
          processed_at: string | null
          processing_error: string | null
          processing_status: string
          received_at: string
          source: string
          webhook_id: string
        }
        Insert: {
          call_external_id?: string | null
          headers?: Json | null
          payload?: Json | null
          processed_at?: string | null
          processing_error?: string | null
          processing_status?: string
          received_at?: string
          source?: string
          webhook_id: string
        }
        Update: {
          call_external_id?: string | null
          headers?: Json | null
          payload?: Json | null
          processed_at?: string | null
          processing_error?: string | null
          processing_status?: string
          received_at?: string
          source?: string
          webhook_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      change_primary_csm: {
        Args: { p_client_id: string; p_new_team_member_id: string }
        Returns: undefined
      }
      insert_nps_submission: {
        Args: {
          p_client_id: string
          p_feedback?: string
          p_recorded_by?: string
          p_score: number
        }
        Returns: {
          client_id: string
          feedback: string | null
          id: string
          ingested_at: string
          recorded_by: string | null
          score: number
          submitted_at: string
          survey_source: string | null
        }
        SetofOptions: {
          from: "*"
          to: "nps_submissions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      match_document_chunks: {
        Args: {
          client_id?: string
          document_types?: string[]
          include_global?: boolean
          match_count?: number
          min_similarity?: number
          query_embedding: string
          tags?: string[]
        }
        Returns: {
          chunk_id: string
          chunk_index: number
          content: string
          document_created_at: string
          document_id: string
          document_title: string
          document_type: string
          metadata: Json
          similarity: number
        }[]
      }
      merge_clients: {
        Args: { p_source_id: string; p_target_id: string }
        Returns: Json
      }
      update_call_classification: {
        Args: { p_call_id: string; p_changed_by: string; p_changes: Json }
        Returns: Json
      }
      update_client_csm_standing_with_history: {
        Args: {
          p_changed_by?: string
          p_client_id: string
          p_new_csm_standing: string
          p_note?: string
        }
        Returns: {
          accountability_enabled: boolean
          archetype: string | null
          archived_at: string | null
          arrears: number
          arrears_note: string | null
          birth_year: number | null
          contracted_revenue: number | null
          country: string | null
          created_at: string
          csm_standing: string | null
          dfy_setting: boolean | null
          email: string
          full_name: string
          ghl_adoption: string | null
          id: string
          journey_stage: string | null
          location: string | null
          metadata: Json
          notes: string | null
          nps_enabled: boolean
          nps_standing: string | null
          occupation: string | null
          phone: string | null
          program_type: string | null
          sales_group_candidate: boolean | null
          slack_user_id: string | null
          start_date: string | null
          status: string
          tags: string[]
          timezone: string | null
          trustpilot_status: string | null
          updated_at: string
          upfront_cash_collected: number | null
        }
        SetofOptions: {
          from: "*"
          to: "clients"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_client_journey_stage_with_history: {
        Args: {
          p_changed_by?: string
          p_client_id: string
          p_new_journey_stage: string
          p_note?: string
        }
        Returns: {
          accountability_enabled: boolean
          archetype: string | null
          archived_at: string | null
          arrears: number
          arrears_note: string | null
          birth_year: number | null
          contracted_revenue: number | null
          country: string | null
          created_at: string
          csm_standing: string | null
          dfy_setting: boolean | null
          email: string
          full_name: string
          ghl_adoption: string | null
          id: string
          journey_stage: string | null
          location: string | null
          metadata: Json
          notes: string | null
          nps_enabled: boolean
          nps_standing: string | null
          occupation: string | null
          phone: string | null
          program_type: string | null
          sales_group_candidate: boolean | null
          slack_user_id: string | null
          start_date: string | null
          status: string
          tags: string[]
          timezone: string | null
          trustpilot_status: string | null
          updated_at: string
          upfront_cash_collected: number | null
        }
        SetofOptions: {
          from: "*"
          to: "clients"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      update_client_status_with_history: {
        Args: {
          p_changed_by?: string
          p_client_id: string
          p_new_status: string
          p_note?: string
        }
        Returns: {
          accountability_enabled: boolean
          archetype: string | null
          archived_at: string | null
          arrears: number
          arrears_note: string | null
          birth_year: number | null
          contracted_revenue: number | null
          country: string | null
          created_at: string
          csm_standing: string | null
          dfy_setting: boolean | null
          email: string
          full_name: string
          ghl_adoption: string | null
          id: string
          journey_stage: string | null
          location: string | null
          metadata: Json
          notes: string | null
          nps_enabled: boolean
          nps_standing: string | null
          occupation: string | null
          phone: string | null
          program_type: string | null
          sales_group_candidate: boolean | null
          slack_user_id: string | null
          start_date: string | null
          status: string
          tags: string[]
          timezone: string | null
          trustpilot_status: string | null
          updated_at: string
          upfront_cash_collected: number | null
        }
        SetofOptions: {
          from: "*"
          to: "clients"
          isOneToOne: true
          isSetofReturn: false
        }
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

