{{/* Common name + label helpers */}}
{{- define "tesbo.fullname" -}}
{{- printf "%s" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "tesbo.labels" -}}
app.kubernetes.io/name: tesbo-grid
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{/* Build a fully-qualified image ref for an app image name */}}
{{- define "tesbo.image" -}}
{{- printf "%s/%s:%s" .root.Values.image.registry .name .root.Values.image.tag -}}
{{- end -}}

{{/* imagePullSecrets block (rendered only when configured) */}}
{{- define "tesbo.imagePullSecrets" -}}
{{- if .Values.imagePullSecret }}
imagePullSecrets:
  - name: {{ .Values.imagePullSecret }}
{{- end }}
{{- end -}}

{{/* Backend Postgres URL */}}
{{- define "tesbo.databaseUrl" -}}
{{- if .Values.database.url -}}
{{ .Values.database.url }}
{{- else if .Values.database.bundled.enabled -}}
postgresql://postgres:postgres@{{ include "tesbo.fullname" . }}-postgres:5432/tesbo_grid
{{- end -}}
{{- end -}}

{{/* Execution Postgres URL (separate DB) */}}
{{- define "tesbo.executionDatabaseUrl" -}}
{{- if .Values.database.executionUrl -}}
{{ .Values.database.executionUrl }}
{{- else if .Values.database.bundled.enabled -}}
postgresql://postgres:postgres@{{ include "tesbo.fullname" . }}-postgres:5432/tesbo_execution
{{- end -}}
{{- end -}}

{{/* Redis URL */}}
{{- define "tesbo.redisUrl" -}}
{{- if .Values.redis.url -}}
{{ .Values.redis.url }}
{{- else if .Values.redis.bundled.enabled -}}
redis://{{ include "tesbo.fullname" . }}-redis:6379
{{- end -}}
{{- end -}}
