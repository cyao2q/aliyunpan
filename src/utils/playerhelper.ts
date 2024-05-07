import { existsSync } from 'fs'
import message from './message'
import is from 'electron-is'
import { spawn, SpawnOptions } from 'child_process'
import mpvAPI from '../module/node-mpv'
import AliFile from '../aliapi/file'
import AliFileCmd from '../aliapi/filecmd'
import levenshtein from 'fast-levenshtein'
import AliDirFileList from '../aliapi/dirfilelist'
import { ITokenInfo, usePanFileStore, useSettingStore } from '../store'
import { createTmpFile, delTmpFile, GetExpiresTime } from './utils'
import { IAliGetFileModel } from '../aliapi/alimodels'
import { getEncType, getProxyUrl, getRawUrl } from './proxyhelper'
import { CleanStringForCmd } from './filehelper'
import Db from './db'
import { humanTime } from './format'
import { IPageVideo } from '../store/appstore'
import { Input, InputNumber, Modal } from '@arco-design/web-vue'
import { h } from 'vue'
import path from 'path'

const PlayerUtils = {
  filterSubtitleFile(name: string, subTitlesList: IAliGetFileModel[]) {
    // 自动加载同名字幕
    const similarity: any = subTitlesList.reduce(
      (min: any, item, index) => {
        // 莱文斯坦距离算法(计算相似度)
        const distance = levenshtein.get(name, item.name, { useCollator: true })
        if (distance < min.distance) {
          min.distance = distance
          min.index = index
        }
        return min
      },
      { distance: Infinity, index: -1 }
    )
    return similarity.index !== -1 ? subTitlesList[similarity.index] : undefined
  },

  async getVideoDanmuList(pageVideo: IPageVideo, option: any, pos: number) {
    let name = ''
    // console.log('getVideoDanmuList', pageVideo, option, pos)
    if (option.matchType === 'folder') {
      name = pageVideo.parent_file_name
    } else {
      name = pageVideo.file_name
    }
    let searchName = name
      .replace(/\b(19|20)\d{2}\b/g, '')
      .replace(/\b(360p|480p|720p|1080p|2160p|\d+K)\b/gi, '')
      .replace(path.extname(name), '')
      .replace('.', '')
    let numMatch = searchName.match(/(\d{1,3}).*/) || searchName.match(/S(\d+)E(\d+)/i)
    let num = numMatch ? parseInt(numMatch[1] || numMatch[2]) : pos + 1
    console.log('search', searchName, num)
    pageVideo.play_esposide = num
    if (option.sourceType == 'auto' && option.matchEsp == 'auto') {
      return { name: searchName, pos: num }
    }
    if (option.sourceType == 'input') {
      return new Promise((resolve) => {
        let sourceUrl = ''
        // 输入网址
        Modal.open({
          title: '输入弹幕的网址（支持主流视频网址）',
          bodyStyle: {
            minWidth: '500px'
          },
          content: () =>
            h(Input, {
              type: 'text',
              tabindex: '-1',
              allowClear: true,
              placeholder: '输入弹幕的网址',
              onChange(value, ev) {
                sourceUrl = value
              }
            }),
          okText: '确认',
          cancelText: '取消',
          onOk: async (e: any) => {
            console.log('sourceUrl', sourceUrl)
            resolve(sourceUrl)
            return true
          },
          onCancel(e: any) {
            resolve('')
            return true
          }
        })
      })
    }
    if (option.sourceType == 'search') {
      return new Promise((resolve) => {
        let name = ''
        Modal.open({
          title: '输入搜索的关键字，空格分割集数',
          bodyStyle: {
            minWidth: '400px'
          },
          content: () =>
            h(Input, {
              type: 'text',
              tabindex: '-1',
              allowClear: true,
              placeholder: '输入搜索的关键字，空格分割集数',
              onChange(value, ev) {
                name = value
              }
            }),
          okText: '确认',
          cancelText: '取消',
          onOk: async (e: any) => {
            let pos = parseInt(name.split(' ')[1]) || 1
            pageVideo.play_esposide = pos
            resolve({ name, pos })
            return true
          },
          onCancel(e: any) {
            resolve({})
            return true
          }
        })
      })
    }
    if (option.matchEsp == 'input') {
      return new Promise((resolve) => {
        let espisode: any = 1
        Modal.open({
          title: '输入需要匹配的集数',
          bodyStyle: {
            minWidth: '400px'
          },
          content: () =>
            h(InputNumber, {
              defaultValue: pageVideo.play_esposide ? pageVideo.play_esposide : 1,
              tabindex: '-1',
              allowClear: true,
              mode: 'button',
              step: 1,
              placeholder: '输入需要匹配的集数',
              onChange(value, ev) {
                espisode = value
              }
            }),
          okText: '确认',
          cancelText: '取消',
          onOk: async (e: any) => {
            pageVideo.play_esposide = espisode
            resolve({ name, pos: espisode })
            return true
          },
          onCancel(e: any) {
            pageVideo.play_esposide = num
            resolve({ name: searchName, pos: num })
            return true
          }
        })
      })
    }
  },

  async getPlayCursor(user_id: string, drive_id: string, file_id: string) {
    // 获取文件信息
    const info = await AliFile.ApiFileInfo(user_id, drive_id, file_id)
    if (info && typeof info == 'string') {
      message.error('在线预览失败 获取文件信息出错：' + info)
      return undefined
    }
    let play_duration: number = 0
    if (info?.video_media_metadata) {
      play_duration = info?.video_media_metadata.duration
    } else if (info?.user_meta) {
      play_duration = info?.user_meta.duration
    }
    let play_cursor: number = 0
    if (info?.play_cursor) {
      play_cursor = info?.play_cursor
    } else if (info?.user_meta) {
      const meta = JSON.parse(info?.user_meta)
      if (meta.play_cursor) {
        play_cursor = parseFloat(meta.play_cursor)
      }
    }
    // 防止意外跳转
    if (play_duration > 0 && play_duration > 0 && play_cursor >= play_duration - 10) {
      play_cursor = play_duration - 10
    }
    return { play_duration, play_cursor }
  },
  async getDirFileList(user_id: string, drive_id: string, parent_file_id: string) {
    const dir = await AliDirFileList.ApiDirFileList(user_id, drive_id, parent_file_id, '', 'name asc', '')
    const curDirFileList: IAliGetFileModel[] = []
    for (let item of dir.items) {
      if (item.isDir) continue
      curDirFileList.push(item)
    }
    return curDirFileList.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  },
  async createPlayListFile(user_id: string, file_id: string, duration: number, quality: string, play_cursor: number, fileExt: string, fileList: IAliGetFileModel[]) {
    let contentStr = ''
    if (fileExt.includes('m3u')) {
      let header = '#EXTM3U\r\n#EXT-X-ALLOW-CACHE:NO\r\n'
      let end = '#EXT-X-ENDLIST\r\n'
      let list = ''
      for (let item of fileList) {
        const encType = getEncType(item)
        const url = getProxyUrl({
          user_id: user_id,
          drive_id: item.drive_id,
          file_id: item.file_id,
          file_size: item.size,
          weifa: item.icon === 'weifa' ? 1 : 0,
          encType: encType,
          quality: quality
        })
        list += '#EXTINF:0,' + item.name + '\r\n' + url + '\r\n'
      }
      contentStr = header + list + end
    }
    if (fileExt == 'dpl') {
      let header = 'DAUMPLAYLIST'
      let playname = ''
      let playtime = 'playtime=' + play_cursor
      let topindex = 'topindex=0'
      let saveplaypos = `saveplaypos=0`
      let list = ''
      for (let index = 0; index < fileList.length; index++) {
        const item = fileList[index]
        const start = index + 1
        const encType = getEncType(item)
        const url = getProxyUrl({
          user_id: user_id,
          drive_id: item.drive_id,
          file_id: item.file_id,
          file_size: item.size,
          weifa: item.icon === 'weifa' ? 1 : 0,
          encType: encType,
          quality: quality
        })
        let title = CleanStringForCmd(item.name.trim())
        let listStr = `${start}*file*${url}\r\n${start}*title*${title}\r\n${start}*played*0\r\n`
        if (item.file_id === file_id) {
          playname = 'playname=' + url
          if (duration > 0) {
            listStr += `${start}*duration2*${duration}\r\n`
          }
          if (play_cursor > 0) {
            listStr += `${start}*start*${play_cursor}\r\n`
          }
        }
        list += listStr
      }
      contentStr = `${header}\r\n${playname}\r\n${playtime}\r\n${topindex}\r\n${saveplaypos}\r\n${list}`
    }
    return createTmpFile(contentStr, 'play_list' + '.' + fileExt)
  },
  async mpvPlayer(token: ITokenInfo, binary: string, playArgs: any, otherArgs: any, options: SpawnOptions, exitCallBack: any) {
    let { file, fileList, playList, playFileListPath } = otherArgs
    // console.log('otherArgs', otherArgs)
    let { uiAutoColorVideo, uiVideoEnablePlayerList, uiVideoPlayerHistory, uiVideoPlayerExit, uiVideoSubtitleMode } = useSettingStore()
    let socketPath = is.windows() ? '\\\\.\\pipe\\mpvserver' : '/tmp/mpvserver.sock'
    let currentTime = 0
    let currentFileId = file.file_id
    let mpv: mpvAPI = new mpvAPI(
      {
        debug: false,
        verbose: false,
        binary: binary,
        socket: socketPath,
        spawnOptions: options
      },
      playArgs
    )
    try {
      await mpv.start()
      if (uiVideoEnablePlayerList) {
        await mpv.loadPlaylist(playFileListPath)
        await mpv.play()
        mpv.on('status', async (status: { property: string; value: any }) => {
          // console.log('status', status)
          if (status.property === 'playlist-pos' && status.value != -1) {
            // 保存历史
            const item = playList[status.value]
            await AliFile.ApiUpdateVideoTime(token.user_id, item.drive_id, currentFileId, currentTime)
            currentFileId = (item && item.file_id) || undefined
            if (currentFileId && uiAutoColorVideo && !item.description.includes('ce74c3c')) {
              AliFileCmd.ApiFileColorBatch(token.user_id, item.drive_id, item.description ? item.description + ',' + 'ce74c3c' : 'ce74c3c', [currentFileId]).then((success) => {
                usePanFileStore().mColorFiles('ce74c3c', success)
              })
            }
            mpv.once('started', async () => {
              if (currentFileId && uiVideoPlayerHistory) {
                let playCursorInfo = await this.getPlayCursor(token.user_id, file.drive_id, currentFileId)
                if (playCursorInfo && playCursorInfo.play_cursor > 0) {
                  await mpv.seek(playCursorInfo.play_cursor, 'absolute')
                }
              }
              if (item && uiVideoSubtitleMode === 'auto') {
                let filename = item.name
                let proxyInfo: any = await Db.getValueObject('ProxyInfo')
                if (proxyInfo.subtitle_url) {
                  await mpv.addSubtitles(proxyInfo.subtitle_url, 'select', filename)
                } else {
                  let subTitlesList = fileList.filter((file: any) => /srt|vtt|ass/.test(file.ext))
                  if (subTitlesList.length > 0) {
                    let subTitleFile = this.filterSubtitleFile(filename, subTitlesList)
                    if (subTitleFile) {
                      const data = await getRawUrl(token.user_id, subTitleFile.drive_id, subTitleFile.file_id, getEncType(subTitleFile))
                      if (typeof data !== 'string' && data.url && data.url != '') {
                        await mpv.addSubtitles(data.url, 'select', subTitleFile.name || filename)
                      }
                    }
                  }
                }
              }
            })
          }
        })
      }
      mpv.on('timeposition', (timeposition: number) => {
        // console.log('timeposition', currentTime)
        currentTime = timeposition
      })
      mpv.on('quit', async () => {
        if (currentFileId) {
          await AliFile.ApiUpdateVideoTime(token.user_id, file.drive_id, currentFileId, currentTime)
        }
        exitCallBack()
      })
      if (uiVideoPlayerExit) {
        mpv.on('stopped', async () => {
          message.info('播放完毕，自动退出软件', 8)
          if (currentFileId) {
            await AliFile.ApiUpdateVideoTime(token.user_id, file.drive_id, currentFileId, currentTime)
          }
          await mpv.quit()
        })
      }
    } catch (error: any) {
      console.error(error)
      if (error.errcode == 6) {
        message.error('播放失败，重复运行MPV播放器', 8)
      } else {
        message.error(`播放失败，${error.verbose}`)
      }
      exitCallBack()
    }
  },

  commandSpawn(commandStr: string, playArgs: any, options: SpawnOptions, exitCallBack: any) {
    const childProcess: any = spawn(commandStr, playArgs, {
      shell: true,
      windowsVerbatimArguments: true,
      ...options
    })
    childProcess.unref()
    if (exitCallBack) {
      childProcess.once('exit', async () => {
        exitCallBack()
      })
    }
  },

  async startPlayer(token: ITokenInfo, command: string, otherArgs: any) {
    if ((is.windows() || is.macOS()) && !existsSync(command)) {
      message.error(`启动失败，找不到文件, ${command}`)
      return
    }
    const argsToStr = (args: string) => (is.windows() ? `"${args}"` : `'${args}'`)
    const isMPV = command.toLowerCase().includes('mpv')
    const isPotplayer = command.toLowerCase().includes('potplayer')
    let commandStr
    if (is.macOS()) {
      commandStr = `open -a ${argsToStr(command)} ${command.includes('mpv.app') ? '--args ' : ''}`
    } else {
      commandStr = `${argsToStr(command)}`
    }
    // 构造播放参数
    let { file, subTitleFile, play_cursor, play_duration, rawData, quality, password } = otherArgs
    let encType = getEncType(file)
    let play_url = ''
    let play_referer = token.open_api_enable ? 'https://openapi.alipan.com/' : 'https://www.alipan.com/'
    let { uiVideoEnablePlayerList, uiVideoPlayerExit, uiVideoPlayerHistory, uiVideoPlayerParams } = useSettingStore()
    let playerArgs: any = []
    let subTitleUrl = ''
    if (rawData) {
      // 加载转码的内嵌字幕
      if (rawData.subtitles && quality != 'Origin') {
        let subTitleData = rawData.subtitles.find((sub: any) => sub.language === 'chi') || rawData.subtitles[0]
        subTitleUrl = (subTitleData && subTitleData.url) || ''
      }
      if (rawData.qualities) {
        play_url = rawData.qualities.find((q: any) => q.quality === quality)?.url || rawData.qualities[0].url
      }
    }
    // 加载网盘内字幕文件
    if (subTitleFile) {
      const data = await getRawUrl(token.user_id, subTitleFile.drive_id, subTitleFile.file_id, getEncType(subTitleFile), password)
      if (typeof data !== 'string' && data.url && data.url != '') {
        subTitleUrl = data.url
      }
    }
    let options: SpawnOptions = { detached: !uiVideoPlayerExit }
    if (isPotplayer) {
      playerArgs = ['/new', '/autoplay', `/referer=${argsToStr(play_referer)}`, `/title=${argsToStr(file.name)}`]
      if (play_cursor > 0 && uiVideoPlayerHistory) {
        playerArgs.push(`/seek=${argsToStr(humanTime(play_cursor))}`)
      }
      if (subTitleUrl.length > 0) {
        playerArgs.push(`/sub=${argsToStr(subTitleUrl)}`)
      }
    }
    if (isMPV) {
      playerArgs = [
        '--force-window=immediate',
        '--hwdec=auto',
        '--geometry=80%',
        '--autofit-larger=100%x100%',
        '--autofit-smaller=640',
        '--audio-pitch-correction=yes',
        '--keep-open-pause=no',
        '--alang=[en,eng,zh,chi,chs,sc,zho]',
        '--slang=[zh,chi,chs,sc,zho,en,eng]',
        `--force-media-title=${argsToStr(file.name)}`,
        `--referrer=${argsToStr(play_referer)}`,
        `--title=${argsToStr(file.name)}`
      ]
      if (play_cursor > 0 && uiVideoPlayerHistory) {
        playerArgs.push(`--start=${argsToStr(humanTime(play_cursor))}`)
      }
      if (subTitleUrl.length > 0) {
        playerArgs.push(`--sub-file=${argsToStr(subTitleUrl)}`)
      }
    }
    if (isMPV && uiVideoPlayerParams.length > 0) {
      const params = uiVideoPlayerParams.replaceAll(/\s+/g, '').split(',')
      playerArgs.push(...params)
    }
    const playArgs: any[] = [...Array.from(new Set(playerArgs))]
    let fileList: IAliGetFileModel[] = []
    if (uiVideoEnablePlayerList) {
      if (file.compilation_id) {
        fileList = await this.getDirFileList(token.user_id, file.drive_id, file.parent_file_id)
      } else {
        fileList = usePanFileStore().ListDataRaw
      }
      otherArgs.fileList = fileList
      console.log('getDirFileList', fileList)
      otherArgs.playList = fileList.filter((v: any) => v.category.includes('video'))
      otherArgs.playFileListPath = await this.createPlayListFile(token.user_id, file.file_id, play_duration, quality, play_cursor, isPotplayer ? 'dpl' : 'm3u', otherArgs.playList)
      // console.log('tmpFile', tmpFile)
      const playIndex = otherArgs.playList.findIndex((v: any) => v.file_id == file.file_id) || 0
      if (isMPV) {
        playArgs.push(`--playlist-start=${playIndex}`)
      } else {
        playArgs.unshift(otherArgs.playFileListPath)
      }
    } else {
      playArgs.unshift(argsToStr(play_url))
    }
    console.warn('playArgs', playArgs)
    const exitCallBack = () => {
      if (uiVideoEnablePlayerList) {
        delTmpFile(otherArgs.playFileListPath)
      }
      otherArgs = {}
    }
    if (!encType && rawData) {
      let info: any = {
        user_id: token.user_id,
        drive_id: file.drive_id,
        file_id: file.file_id,
        file_size: file.size,
        encType: encType,
        videoQuality: quality,
        expires_time: GetExpiresTime(play_url),
        proxy_url: play_url,
        subtitle_url: subTitleUrl
      }
      await Db.saveValueObject('ProxyInfo', info)
    }
    if (uiVideoEnablePlayerList || uiVideoPlayerHistory) {
      if (isMPV) {
        await this.mpvPlayer(token, commandStr, playArgs, otherArgs, options, exitCallBack)
      } else {
        this.commandSpawn(commandStr, playArgs, options, exitCallBack)
      }
    } else {
      this.commandSpawn(commandStr, playArgs, options, exitCallBack)
    }
  }
}
export default PlayerUtils
