import React, { useEffect, useState } from 'react';
import { useGoogleLogin } from '@react-oauth/google';
import type { PlaylistItem } from '../types';

// We'll require the user to provide their own Client ID and API Key in a .env file or UI input.
const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';
const API_KEY = import.meta.env.VITE_GOOGLE_API_KEY || '';
const DISCOVERY_DOCS = ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'];
const SCOPES = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file';

interface Props {
  onPlaylistLoaded: (playlist: PlaylistItem[]) => void;
  onTokenReceived?: (token: string) => void;
}

export const GoogleDriveConnector: React.FC<Props> = ({ onPlaylistLoaded, onTokenReceived }) => {
  const [isReady, setIsReady] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Load gapi script
    const loadGapi = async () => {
      const gapi = (window as any).gapi;
      if (!gapi) return;
      gapi.load('client:picker', async () => {
        try {
          await gapi.client.init({
            apiKey: API_KEY,
            discoveryDocs: DISCOVERY_DOCS,
          });
          setIsReady(true);
        } catch (e) {
          console.error('Error initializing GAPI client', e);
          setError('Failed to initialize Google API. Check API Key.');
        }
      });
    };

    const script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js';
    script.onload = loadGapi;
    document.body.appendChild(script);

    return () => {
      document.body.removeChild(script);
    };
  }, []);

  const login = useGoogleLogin({
    onSuccess: (tokenResponse) => {
      setToken(tokenResponse.access_token);
      if (onTokenReceived) onTokenReceived(tokenResponse.access_token);
    },
    scope: SCOPES,
    onError: (error) => {
      console.error('Login Failed', error);
      setError('Google Login Failed');
    }
  });

  const openPicker = () => {
    if (!token || !isReady) return;
    const view = new (window as any).google.picker.DocsView((window as any).google.picker.ViewId.FOLDERS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(true);

    const videoView = new (window as any).google.picker.DocsView((window as any).google.picker.ViewId.DOCS)
      .setMimeTypes('video/mp4,video/quicktime,video/x-msvideo');

    const picker = new (window as any).google.picker.PickerBuilder()
      .addView(view)
      .addView(videoView)
      .setOAuthToken(token)
      .setDeveloperKey(API_KEY)
      .setCallback((data: any) => pickerCallback(data))
      .build();
    
    picker.setVisible(true);
  };

  const pickerCallback = async (data: any) => {
    if (data.action === (window as any).google.picker.Action.PICKED) {
      const doc = data.docs[0];
      
      if (doc.mimeType === 'application/vnd.google-apps.folder') {
        // Fetch videos inside the folder
        await fetchFolderContents(doc.id);
      } else {
        // Single or multiple video files selected
        const playlist: PlaylistItem[] = data.docs.map((d: any) => ({
          id: d.id,
          name: d.name,
          driveUrl: `https://www.googleapis.com/drive/v3/files/${d.id}?alt=media`,
        }));
        onPlaylistLoaded(playlist);
      }
    }
  };

  const fetchFolderContents = async (folderId: string) => {
    if (!token) return;
    try {
      const gapi = (window as any).gapi;
      const response = await gapi.client.drive.files.list({
        q: `'${folderId}' in parents and (mimeType contains 'video/') and trashed = false`,
        fields: 'files(id, name, mimeType)',
        pageSize: 1000
      });
      
      const files = response.result.files || [];
      const playlist: PlaylistItem[] = files.map((f: any) => ({
        id: f.id,
        name: f.name,
        driveUrl: `https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`,
      }));
      
      onPlaylistLoaded(playlist);
    } catch (err) {
      console.error('Error fetching folder', err);
      setError('Failed to fetch folder contents');
    }
  };

  if (!CLIENT_ID) {
    return (
      <div style={{ color: '#ef4444', fontSize: '0.85rem', padding: '1rem', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '8px', textAlign: 'left', lineHeight: 1.4 }}>
        <strong>Google Drive Disabled</strong><br/>
        Create a <code style={{color: '#f8fafc', background: 'rgba(0,0,0,0.3)', padding: '2px 4px', borderRadius: '4px'}}>.env</code> file locally with your <br/>
        <code>VITE_GOOGLE_CLIENT_ID</code> and <code>VITE_GOOGLE_API_KEY</code>.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', width: '100%' }}>
      {error && <div style={{ color: 'red', fontSize: '0.8rem' }}>{error}</div>}
      
      {!token ? (
        <button className="btn outline" onClick={() => login()} disabled={!isReady} style={{ width: '100%' }}>
          Login with Google
        </button>
      ) : (
        <button className="btn" onClick={openPicker} disabled={!isReady} style={{ width: '100%' }}>
          Select Drive Folder/Videos
        </button>
      )}
    </div>
  );
};

