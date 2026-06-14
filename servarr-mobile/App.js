import React, { useMemo, useState } from 'react';
import {
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Pressable,
  Switch,
  Alert
} from 'react-native';
import { StatusBar } from 'expo-status-bar';

const dark = {
  bg: '#060b18',
  card: '#121a34',
  border: '#2a355f',
  text: '#e8eeff',
  muted: '#98a6d6',
  accent: '#22d3ee',
  success: '#22c55e',
  danger: '#f87171'
};

async function api(baseUrl, path, method = 'GET', body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export default function App() {
  const [baseUrl, setBaseUrl] = useState('http://localhost:5055');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState(null);
  const [config, setConfig] = useState(null);

  const canUse = useMemo(() => !!config, [config]);

  const loadAll = async () => {
    setLoading(true);
    try {
      const data = await api(baseUrl, '/api/status');
      setStatus(data);
      setConfig(data.config);
    } catch (e) {
      Alert.alert('Load failed', e.message);
    } finally {
      setLoading(false);
    }
  };

  const saveConfig = async () => {
    if (!config) return;
    setLoading(true);
    try {
      await api(baseUrl, '/api/config', 'POST', {
        sonarrEnabled: config.sonarr.enabled,
        radarrEnabled: config.radarr.enabled,
        sabnzbdEnabled: config.sabnzbd.enabled,
        sonarrPort: config.sonarr.port,
        radarrPort: config.radarr.port,
        sabPort: config.sabnzbd.port,
        sonarrUrl: config.sonarr.url,
        radarrUrl: config.radarr.url,
        sabUrl: config.sabnzbd.url,
        sonarrApiKey: config.sonarr.apiKey,
        radarrApiKey: config.radarr.apiKey,
        sabApiKey: config.sabnzbd.apiKey,
        tvRoot: config.sonarr.tvRoot,
        movieRoot: config.radarr.movieRoot,
        mediaRoot: config.paths.mediaRoot,
        downloadsRoot: config.paths.downloadsRoot,
        timezone: config.runtime.timezone,
        puid: config.runtime.puid,
        pgid: config.runtime.pgid,
        tvCategory: config.sabnzbd.tvCategory,
        movieCategory: config.sabnzbd.movieCategory
      });
      Alert.alert('Saved', 'Configuration saved');
    } catch (e) {
      Alert.alert('Save failed', e.message);
    } finally {
      setLoading(false);
    }
  };

  const doAction = async (path, successLabel) => {
    setLoading(true);
    try {
      await api(baseUrl, path, 'POST');
      Alert.alert('Success', successLabel);
      await loadAll();
    } catch (e) {
      Alert.alert('Action failed', e.message);
    } finally {
      setLoading(false);
    }
  };

  const containerAction = async (name, action) => doAction(`/container/${name}/${action}`, `${name} ${action}ed`);

  const setNested = (section, key, value) => {
    setConfig(prev => ({ ...prev, [section]: { ...prev[section], [key]: value } }));
  };

  const setPath = (key, value) => {
    setConfig(prev => ({ ...prev, paths: { ...prev.paths, [key]: value } }));
  };

  const setRuntime = (key, value) => {
    setConfig(prev => ({ ...prev, runtime: { ...prev.runtime, [key]: value } }));
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, gap: 12 }}>
        <Text style={styles.title}>❯ wslservarr mobile</Text>

        <View style={styles.card}>
          <Text style={styles.label}>API Base URL</Text>
          <TextInput style={styles.input} value={baseUrl} onChangeText={setBaseUrl} autoCapitalize="none" />
          <Pressable style={styles.button} onPress={loadAll} disabled={loading}>
            <Text style={styles.buttonText}>{loading ? 'loading...' : 'connect + load'}</Text>
          </Pressable>
          <Text style={styles.hint}>Use host IP instead of localhost on physical devices.</Text>
        </View>

        {!!status?.checks && (
          <View style={styles.card}>
            <Text style={styles.section}>Environment</Text>
            {Object.entries(status.checks).map(([k, v]) => (
              <Text key={k} style={[styles.item, typeof v === 'boolean' ? (v ? styles.ok : styles.bad) : styles.muted]}>
                {k}: {String(v)}
              </Text>
            ))}
          </View>
        )}

        {canUse && (
          <>
            <View style={styles.card}>
              <Text style={styles.section}>Services</Text>

              <RowToggle label="Sonarr" value={config.sonarr.enabled} onValueChange={v => setNested('sonarr', 'enabled', v)} />
              <RowToggle label="Radarr" value={config.radarr.enabled} onValueChange={v => setNested('radarr', 'enabled', v)} />
              <RowToggle label="SABnzbd" value={config.sabnzbd.enabled} onValueChange={v => setNested('sabnzbd', 'enabled', v)} />

              <LabeledInput label="Sonarr API Key" value={config.sonarr.apiKey} onChangeText={v => setNested('sonarr', 'apiKey', v)} secureTextEntry />
              <LabeledInput label="Radarr API Key" value={config.radarr.apiKey} onChangeText={v => setNested('radarr', 'apiKey', v)} secureTextEntry />
              <LabeledInput label="SABnzbd API Key" value={config.sabnzbd.apiKey} onChangeText={v => setNested('sabnzbd', 'apiKey', v)} secureTextEntry />

              <LabeledInput label="Media Root" value={config.paths.mediaRoot} onChangeText={v => setPath('mediaRoot', v)} />
              <LabeledInput label="Downloads Root" value={config.paths.downloadsRoot} onChangeText={v => setPath('downloadsRoot', v)} />
              <LabeledInput label="Timezone" value={config.runtime.timezone} onChangeText={v => setRuntime('timezone', v)} />
            </View>

            <View style={styles.card}>
              <Text style={styles.section}>Actions</Text>
              <ButtonRow label="Save Config" onPress={saveConfig} />
              <ButtonRow label="Install/Update Apps" onPress={() => doAction('/api/install/apps', 'Apps installed/updated')} />
              <ButtonRow label="Apply Arr Settings" onPress={() => doAction('/api/apply', 'Arr settings applied')} />
              <ButtonRow label="Test Sonarr" onPress={() => doAction('/api/test/sonarr', 'Sonarr connection OK')} />
              <ButtonRow label="Test Radarr" onPress={() => doAction('/api/test/radarr', 'Radarr connection OK')} />
              <ButtonRow label="Test SABnzbd" onPress={() => doAction('/api/test/sabnzbd', 'SABnzbd connection OK')} />
            </View>

            <View style={styles.card}>
              <Text style={styles.section}>Containers</Text>
              {(status?.containers || []).map(c => (
                <View key={c.name} style={styles.containerRow}>
                  <Text style={styles.item}>{c.name} ({c.status})</Text>
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <MiniBtn label="start" onPress={() => containerAction(c.name, 'start')} />
                    <MiniBtn label="stop" onPress={() => containerAction(c.name, 'stop')} />
                    <MiniBtn label="restart" onPress={() => containerAction(c.name, 'restart')} />
                  </View>
                </View>
              ))}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function LabeledInput({ label, ...props }) {
  return (
    <View style={{ marginBottom: 10 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput style={styles.input} placeholderTextColor={dark.muted} {...props} />
    </View>
  );
}

function RowToggle({ label, value, onValueChange }) {
  return (
    <View style={styles.row}>
      <Text style={styles.item}>{label}</Text>
      <Switch value={value} onValueChange={onValueChange} />
    </View>
  );
}

function ButtonRow({ label, onPress }) {
  return (
    <Pressable style={[styles.button, { marginBottom: 8 }]} onPress={onPress}>
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

function MiniBtn({ label, onPress }) {
  return (
    <Pressable style={styles.miniBtn} onPress={onPress}>
      <Text style={{ color: dark.text, fontSize: 12 }}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: dark.bg },
  container: { flex: 1, backgroundColor: dark.bg },
  title: { color: dark.accent, fontSize: 28, fontWeight: '700', marginTop: 4, marginBottom: 4 },
  card: { backgroundColor: dark.card, borderColor: dark.border, borderWidth: 1, borderRadius: 10, padding: 14 },
  section: { color: dark.text, fontSize: 18, fontWeight: '700', marginBottom: 10 },
  label: { color: dark.muted, marginBottom: 4 },
  input: { borderColor: dark.border, borderWidth: 1, borderRadius: 8, padding: 10, color: dark.text, backgroundColor: '#0b1330' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  item: { color: dark.text, marginBottom: 4 },
  button: { backgroundColor: dark.accent, borderRadius: 8, padding: 12, alignItems: 'center' },
  buttonText: { color: '#001018', fontWeight: '700' },
  miniBtn: { borderColor: dark.border, borderWidth: 1, borderRadius: 6, paddingVertical: 6, paddingHorizontal: 8, backgroundColor: '#182349' },
  containerRow: { marginBottom: 10, borderTopColor: dark.border, borderTopWidth: 1, paddingTop: 8 },
  hint: { color: dark.muted, marginTop: 8, fontSize: 12 },
  muted: { color: dark.muted },
  ok: { color: dark.success },
  bad: { color: dark.danger }
});
