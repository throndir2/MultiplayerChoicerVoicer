import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import type { AppConfig } from '../config.js'

export interface RunOptions {
  onStdoutLine?: (line: string) => void
  timeoutMs?: number
  cwd?: string
}

export interface RunResult {
  stdout: string
  stderr: string
}

export class CommandError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message)
  }
}

export function runCommand(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let pending = ''
    const timer = options.timeoutMs
      ? setTimeout(() => child.kill('SIGKILL'), options.timeoutMs)
      : null
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (options.onStdoutLine) {
        pending += chunk
        const lines = pending.split(/\r?\n/)
        pending = lines.pop() ?? ''
        for (const line of lines) options.onStdoutLine(line)
      } else if (stdout.length < 4_000_000) {
        stdout += chunk
      }
    })
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000)
    })
    child.on('error', (error) => {
      if (timer) clearTimeout(timer)
      reject(new CommandError(`${command} could not start: ${error.message}`, ''))
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new CommandError(`${command} exited with code ${code}: ${stderr.slice(-600)}`, stderr))
    })
  })
}

export interface ProbeResult {
  duration: number
  width: number
  height: number
  hasVideo: boolean
  hasAudio: boolean
  videoCodec: string | null
  audioCodec: string | null
}

interface FfprobeJson {
  format?: { duration?: string }
  streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; duration?: string }[]
}

const SUBTITLE_TIME = (seconds: number): string => {
  const ms = Math.max(0, Math.round(seconds * 1000))
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  const secs = Math.floor((ms % 60_000) / 1000)
  const millis = ms % 1000
  const pad = (value: number, size = 2) => value.toString().padStart(size, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(millis, 3)}`
}

export interface RenderCue {
  file: string
  time: number
}

export interface SubtitleEntry {
  start: number
  end: number
  text: string
}

export class Media {
  constructor(private readonly config: AppConfig) {}

  private ffmpegArgs(args: string[]): string[] {
    const threads = this.config.ffmpegThreads > 0 ? ['-threads', String(this.config.ffmpegThreads)] : []
    return ['-hide_banner', '-nostdin', '-y', '-v', 'error', ...threads, ...args]
  }

  async checkTools(): Promise<string[]> {
    const missing: string[] = []
    const checks: [string, string[]][] = [
      [this.config.ffmpeg, ['-version']],
      [this.config.ffprobe, ['-version']],
      [this.config.archiveTool, ['--version']],
    ]
    for (const [command, args] of checks) {
      try {
        await runCommand(command, args, { timeoutMs: 15_000 })
      } catch {
        missing.push(command)
      }
    }
    return missing
  }

  async probe(file: string): Promise<ProbeResult> {
    const { stdout } = await runCommand(
      this.config.ffprobe,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { timeoutMs: 60_000 },
    )
    const json = JSON.parse(stdout) as FfprobeJson
    const streams = json.streams ?? []
    const video = streams.find((stream) => stream.codec_type === 'video')
    const audio = streams.find((stream) => stream.codec_type === 'audio')
    const duration =
      Number(json.format?.duration) ||
      Number(video?.duration) ||
      Number(audio?.duration) ||
      0
    return {
      duration: Number.isFinite(duration) ? duration : 0,
      width: video?.width ?? 0,
      height: video?.height ?? 0,
      hasVideo: Boolean(video),
      hasAudio: Boolean(audio),
      videoCodec: video?.codec_name ?? null,
      audioCodec: audio?.codec_name ?? null,
    }
  }

  async duration(file: string): Promise<number> {
    try {
      return (await this.probe(file)).duration
    } catch {
      return 0
    }
  }

  async imageToJpeg(input: string, output: string, maxWidth: number): Promise<void> {
    await runCommand(
      this.config.ffmpeg,
      this.ffmpegArgs([
        '-i',
        input,
        '-frames:v',
        '1',
        '-vf',
        `scale='min(${maxWidth},iw)':-2:flags=bicubic`,
        '-q:v',
        '4',
        output,
      ]),
      { timeoutMs: 60_000 },
    )
  }

  async videoFrameToJpeg(video: string, output: string, at: number, maxWidth: number): Promise<void> {
    await runCommand(
      this.config.ffmpeg,
      this.ffmpegArgs([
        '-ss',
        at.toFixed(3),
        '-i',
        video,
        '-frames:v',
        '1',
        '-vf',
        `scale='min(${maxWidth},iw)':-2:flags=bicubic`,
        '-q:v',
        '4',
        output,
      ]),
      { timeoutMs: 120_000 },
    )
  }

  /** Copies MP3 files unchanged and converts any other audio to MP3. */
  async audioToMp3(input: string, output: string, mono: boolean): Promise<void> {
    if (input.toLowerCase().endsWith('.mp3')) {
      await fs.copyFile(input, output)
      return
    }
    await runCommand(
      this.config.ffmpeg,
      this.ffmpegArgs([
        '-i',
        input,
        '-vn',
        ...(mono ? ['-ac', '1'] : ['-ac', '2']),
        '-c:a',
        'libmp3lame',
        '-b:a',
        mono ? '96k' : '160k',
        output,
      ]),
      { timeoutMs: 300_000 },
    )
  }

  async transcodeVideo(
    input: string,
    output: string,
    duration: number,
    onProgress: (fraction: number) => void,
  ): Promise<void> {
    const height = this.config.videoMaxHeight
    await runCommand(
      this.config.ffmpeg,
      this.ffmpegArgs([
        '-i',
        input,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-vf',
        `scale=-2:'min(${height},ih)':flags=bicubic,format=yuv420p`,
        '-c:v',
        'libx264',
        '-preset',
        this.config.videoPreset,
        '-crf',
        String(this.config.videoCrf),
        '-profile:v',
        'high',
        '-c:a',
        'aac',
        '-b:a',
        '96k',
        '-ac',
        '2',
        '-movflags',
        '+faststart',
        '-progress',
        'pipe:1',
        '-nostats',
        output,
      ]),
      {
        onStdoutLine: (line) => {
          const match = /^out_time_(?:us|ms)=(\d+)/.exec(line)
          if (match && duration > 0) onProgress(Math.min(1, Number(match[1]) / 1_000_000 / duration))
        },
      },
    )
  }

  /**
   * Trims silence at both ends, normalises the loudness and stores AAC, which every browser
   * can decode. A take that is all silence is kept without the trim.
   */
  async processRecording(input: string, output: string): Promise<number> {
    const trim =
      'silenceremove=start_periods=1:start_threshold=-42dB:start_silence=0.06,' +
      'areverse,silenceremove=start_periods=1:start_threshold=-42dB:start_silence=0.2,areverse,'
    const normalise = 'loudnorm=I=-16:TP=-1.5:LRA=11'
    const encode = ['-ar', '48000', '-ac', '1', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart']
    await runCommand(this.config.ffmpeg, this.ffmpegArgs(['-i', input, '-vn', '-af', trim + normalise, ...encode, output]), {
      timeoutMs: 120_000,
    })
    let duration = await this.duration(output)
    if (duration < 0.15) {
      await runCommand(this.config.ffmpeg, this.ffmpegArgs(['-i', input, '-vn', '-af', normalise, ...encode, output]), {
        timeoutMs: 120_000,
      })
      duration = await this.duration(output)
    }
    return duration
  }

  /** Decodes the first audio stream to mono 32-bit float samples at `sampleRate`. */
  decodePcm(file: string, sampleRate: number): Promise<Float32Array> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.config.ffmpeg,
        this.ffmpegArgs(['-i', file, '-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', 'pipe:1']),
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      )
      const chunks: Buffer[] = []
      let size = 0
      let stderr = ''
      const limit = sampleRate * 4 * 120
      const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
      child.stdout.on('data', (chunk: Buffer) => {
        if (size < limit) {
          chunks.push(chunk)
          size += chunk.length
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-2000)
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(new CommandError(`ffmpeg could not start: ${error.message}`, ''))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code !== 0) {
          reject(new CommandError(`ffmpeg exited with code ${code}: ${stderr.slice(-600)}`, stderr))
          return
        }
        const buffer = Buffer.concat(chunks)
        const samples = new Float32Array(Math.floor(buffer.length / 4))
        for (let index = 0; index < samples.length; index += 1) samples[index] = buffer.readFloatLE(index * 4)
        resolve(samples)
      })
    })
  }

  async extractArchive(archive: string, destination: string): Promise<void> {
    await runCommand(this.config.archiveTool, ['-x', '-f', archive, '-C', destination], {
      timeoutMs: 30 * 60_000,
    })
  }

  async renderDub(options: {
    video: string
    backing: string | null
    cues: RenderCue[]
    subtitles: SubtitleEntry[]
    subtitleFile: string
    duration: number
    output: string
    onProgress: (fraction: number) => void
  }): Promise<void> {
    const srt = options.subtitles
      .map((entry, index) => `${index + 1}\n${SUBTITLE_TIME(entry.start)} --> ${SUBTITLE_TIME(entry.end)}\n${entry.text}\n`)
      .join('\n')
    await fs.writeFile(options.subtitleFile, srt, 'utf8')

    const duration = options.duration.toFixed(3)
    const inputs: string[] = ['-i', options.video, '-f', 'lavfi', '-t', duration, '-i', 'anullsrc=r=48000:cl=stereo']
    const filters: string[] = []
    const mixInputs: string[] = ['[1:a]']
    let inputIndex = 2
    if (options.backing) {
      inputs.push('-i', options.backing)
      filters.push(`[${inputIndex}:a]aresample=48000,aformat=channel_layouts=stereo[bg]`)
      mixInputs.push('[bg]')
      inputIndex += 1
    }
    options.cues.forEach((cue, index) => {
      inputs.push('-i', cue.file)
      const delay = Math.max(0, Math.round(cue.time * 1000))
      filters.push(
        `[${inputIndex}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${delay}|${delay}[c${index}]`,
      )
      mixInputs.push(`[c${index}]`)
      inputIndex += 1
    })
    const subtitleIndex = inputIndex
    inputs.push('-i', options.subtitleFile)
    filters.push(
      `${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]`,
    )

    await runCommand(
      this.config.ffmpeg,
      this.ffmpegArgs([
        ...inputs,
        '-filter_complex',
        filters.join(';'),
        '-map',
        '0:v:0',
        '-map',
        '[aout]',
        '-map',
        `${subtitleIndex}:s?`,
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-b:a',
        '160k',
        '-c:s',
        'mov_text',
        '-metadata:s:s:0',
        'language=eng',
        '-t',
        duration,
        '-movflags',
        '+faststart',
        '-progress',
        'pipe:1',
        '-nostats',
        options.output,
      ]),
      {
        onStdoutLine: (line) => {
          const match = /^out_time_(?:us|ms)=(\d+)/.exec(line)
          if (match && options.duration > 0) {
            options.onProgress(Math.min(1, Number(match[1]) / 1_000_000 / options.duration))
          }
        },
      },
    )
  }
}
