{{/*
A version is not always a legal label value. Flux installs an OCI chart as
"0.1.0+<digest>", and "+" is not allowed in a label, so every object would be
refused. Same treatment as Helm's own chart scaffold, plus a strip of
anything else a label cannot hold.
*/}}
{{- define "bmm.labelValue" -}}
{{- regexReplaceAll "[^A-Za-z0-9._-]" (toString .) "_" | trunc 63 | trimSuffix "-" | trimSuffix "_" | trimSuffix "." -}}
{{- end -}}

{{- define "bmm.name" -}}
{{- .Release.Name | trunc 50 | trimSuffix "-" -}}
{{- end -}}

{{- define "bmm.labels" -}}
app.kubernetes.io/name: bmm
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ include "bmm.labelValue" .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ include "bmm.labelValue" (printf "%s-%s" .Chart.Name .Chart.Version) | quote }}
{{- end -}}

{{- define "bmm.selector" -}}
app.kubernetes.io/name: bmm
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "bmm.publicUrl" -}}
{{- if .Values.config.publicUrl -}}
{{- .Values.config.publicUrl -}}
{{- else if .Values.ingress.enabled -}}
{{- printf "%s://%s" (ternary "https" "http" .Values.ingress.tls.enabled) .Values.ingress.host -}}
{{- end -}}
{{- end -}}

{{- define "bmm.pgSecretName" -}}
{{- .Values.postgresql.auth.existingSecret | default (printf "%s-postgres" (include "bmm.name" .)) -}}
{{- end -}}

{{/* The generated password survives upgrades by reading back the Secret. */}}
{{- define "bmm.pgPassword" -}}
{{- if .Values.postgresql.auth.password -}}
{{- .Values.postgresql.auth.password -}}
{{- else -}}
{{- $existing := lookup "v1" "Secret" .Release.Namespace (printf "%s-postgres" (include "bmm.name" .)) -}}
{{- if and $existing $existing.data (index $existing.data "password") -}}
{{- index $existing.data "password" | b64dec -}}
{{- else -}}
{{- randAlphaNum 32 -}}
{{- end -}}
{{- end -}}
{{- end -}}
